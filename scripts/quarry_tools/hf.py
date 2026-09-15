"""`quarry hf` subcommands: fetch datasets from the Hugging Face Hub.

huggingface_hub is imported lazily inside the command functions.
"""

from __future__ import annotations

import argparse
import hashlib
import os
import re
import shutil
import sys
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path, PurePosixPath
from urllib.parse import unquote, urlsplit

_DOWNLOAD_RANGE_DESC = """\
Download a sequential range of files from a Hugging Face repo via the HF SDK.

Give it two .../resolve/<rev>/<file> URLs that are identical except for one counter
(e.g. 00000.parquet and 03633.parquet, or images-1.parquet and images-11.parquet).
The script walks the counter from the first number to the second inclusive,
incrementing by one, and downloads every file with huggingface_hub -- 20 files at
a time by default. The counter is reproduced in the start URL's format: zero-padded
only when the start number itself is zero-padded.

The access token is read from the HF_TOKEN environment variable (falling back to
HUGGINGFACE_HUB_TOKEN). Otherwise authentication is managed by the SDK, which can
use a saved HF login or download anonymously.

Existing, up-to-date files are skipped, so re-running resumes an interrupted batch.
Files land under --output-dir preserving their in-repo path.

Usage:
    HF_TOKEN=hf_xxx quarry hf download-range <url_start> <url_end> [-o DIR] [-w N]
    export HF_TOKEN=hf_xxx
    quarry hf download-range \\
        'https://huggingface.co/datasets/csuhan/midjourney-prompts-FLUX/resolve/main/00000.parquet?download=true' \\
        'https://huggingface.co/datasets/csuhan/midjourney-prompts-FLUX/resolve/main/03633.parquet?download=true'
"""

_URL_REPO_TYPE = {"datasets": "dataset", "spaces": "space"}
_DEFAULT_ENDPOINT = "https://huggingface.co"

_DOWNLOAD_FOLDER_DESC = """\
Download all files in a Hugging Face folder, including its subfolders.

Pass a .../tree/<revision>/<folder> URL. Omit the folder to download from the
repository root. Use --ext parquet (or --ext .parquet) to select only files
ending in that extension; matching is case-sensitive. Without --ext, all files
are downloaded. Files land directly under --output-dir (default: ./<repo-name>),
preserving only subfolders beneath the selected folder. Existing, up-to-date
files are skipped.

Authentication uses HF_TOKEN, then HUGGINGFACE_HUB_TOKEN, then the SDK's saved
token. --dry-run lists matching files without downloading their contents.

Example:
    quarry hf download-folder \\
        'https://huggingface.co/datasets/codeShare/chroma_prompts/tree/main/photoreal/raw' --ext=parquet
"""


class _ParsedUrl:
    __slots__ = ("repo_id", "repo_type", "revision", "path", "endpoint")

    def __init__(self, repo_id, repo_type, revision, path, endpoint):
        self.repo_id = repo_id
        self.repo_type = repo_type
        self.revision = revision
        self.path = path
        self.endpoint = endpoint

    def key(self):
        """Everything that must match between the two URLs (not the file path)."""
        return (self.repo_id, self.repo_type, self.revision, self.endpoint)


def _parse_resolve_url(url: str) -> _ParsedUrl:
    return _parse_repo_url(url, "resolve")


def _parse_repo_url(url: str, kind: str) -> _ParsedUrl:
    parts = urlsplit(url)
    if parts.scheme not in ("http", "https") or not parts.netloc:
        raise SystemExit(f"error: not a valid URL: {url!r}")
    marker = f"/{kind}/"
    if marker not in parts.path:
        raise SystemExit(f"error: not a HF {kind} URL (no {marker!r}): {url!r}")
    left, right = parts.path.split(marker, 1)
    left_segs = left.strip("/").split("/")
    repo_type = None
    if left_segs and left_segs[0] in _URL_REPO_TYPE:
        repo_type = _URL_REPO_TYPE[left_segs[0]]
        repo_id = "/".join(left_segs[1:])
    else:
        repo_id = "/".join(left_segs)
    if len(repo_id.split("/")) != 2 or not all(repo_id.split("/")):
        raise SystemExit(f"error: could not parse repo id from URL: {url!r}")

    right_segs = right.split("/")
    revision = unquote(right_segs[0])
    if not revision:
        raise SystemExit(f"error: no revision found in URL: {url!r}")
    path = unquote("/".join(right_segs[1:]))
    if kind == "tree":
        path = path.rstrip("/")
    if not path and kind == "resolve":
        raise SystemExit(f"error: no file path found in URL: {url!r}")

    endpoint = f"{parts.scheme}://{parts.netloc}"
    return _ParsedUrl(repo_id, repo_type, revision, path, endpoint)


def _find_counter(start: str, end: str):
    """Locate the single incrementing digit-run between two in-repo paths."""
    tok_re = re.compile(r"\d+|\D+")
    a = tok_re.findall(start)
    b = tok_re.findall(end)
    if len(a) != len(b):
        raise SystemExit(
            "error: the two file paths don't share a structure:\n"
            f"  start: {start}\n  end:   {end}"
        )

    differing: list[int] = []
    for i, (ta, tb) in enumerate(zip(a, b)):
        a_digit, b_digit = ta.isdigit(), tb.isdigit()
        if a_digit != b_digit:
            raise SystemExit(
                "error: file paths differ in a non-numeric way:\n"
                f"  start: {start}\n  end:   {end}"
            )
        if ta != tb:
            if not a_digit:
                raise SystemExit(
                    f"error: paths differ outside the number ({ta!r} vs {tb!r}):\n"
                    f"  start: {start}\n  end:   {end}"
                )
            differing.append(i)

    if not differing:
        raise SystemExit("error: the two URLs point at the same file")
    if len(differing) > 1:
        spots = ", ".join(f"{a[i]!r}->{b[i]!r}" for i in differing)
        raise SystemExit(
            "error: more than one number differs between the URLs "
            f"({spots}); cannot tell which one to iterate"
        )

    idx = differing[0]
    start_tok = a[idx]
    start_num, end_num = int(start_tok), int(b[idx])
    if start_num > end_num:
        raise SystemExit(
            f"error: start number {a[idx]} is greater than end number {b[idx]}"
        )
    width = len(start_tok) if start_tok.startswith("0") else 1
    return a, idx, start_num, end_num, width


def _resolve_token() -> str | None:
    return os.environ.get("HF_TOKEN") or os.environ.get("HUGGINGFACE_HUB_TOKEN")


def cmd_download_range(args) -> int:
    token = _resolve_token()
    start = _parse_resolve_url(args.url_start)
    end = _parse_resolve_url(args.url_end)
    if start.key() != end.key():
        raise SystemExit(
            "error: the two URLs must be the same repo / type / revision:\n"
            f"  start: {start.repo_id} [{start.repo_type}] @ {start.revision}"
            f" ({start.endpoint})\n"
            f"  end:   {end.repo_id} [{end.repo_type}] @ {end.revision}"
            f" ({end.endpoint})"
        )

    tokens, idx, start_num, end_num, width = _find_counter(start.path, end.path)

    def path_for(n: int) -> str:
        parts = list(tokens)
        parts[idx] = str(n).zfill(width)
        return "".join(parts)

    files = [path_for(n) for n in range(start_num, end_num + 1)]
    selection = (
        f"Range:    {path_for(start_num)} .. {path_for(end_num)}  "
        f"({len(files)} file(s), counter {start_num}->{end_num} width {width})"
    )
    return _download_files(args, start, files, token, selection)


def cmd_download_folder(args) -> int:
    folder = _parse_repo_url(args.url, "tree")
    os.environ.setdefault("HF_HUB_DISABLE_PROGRESS_BARS", "1")
    from huggingface_hub import HfApi, RepoFile

    token = _resolve_token()
    endpoint = None if folder.endpoint == _DEFAULT_ENDPOINT else folder.endpoint
    api = HfApi(endpoint=endpoint, token=token)
    print(f"Listing {folder.repo_id}/{folder.path} @ {folder.revision}...", file=sys.stderr)
    try:
        files = sorted(
            entry.path
            for entry in api.list_repo_tree(
                repo_id=folder.repo_id,
                path_in_repo=folder.path or None,
                repo_type=folder.repo_type,
                revision=folder.revision,
                recursive=True,
            )
            if isinstance(entry, RepoFile)
            and (args.ext is None or entry.path.endswith(args.ext))
        )
    except Exception as exc:
        print(f"error: could not list folder: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 1
    if not files:
        print("No matching files found; nothing downloaded.", file=sys.stderr)
        return 0
    selection = (
        f"Folder:   {folder.path or '/'} (including subfolders)\n"
        f"Filter:   {'*' + args.ext if args.ext else 'all files'} ({len(files)} file(s))"
    )
    return _download_files(args, folder, files, token, selection, path_prefix=folder.path)


def _copy_atomic(source: Path, destination: Path) -> None:
    """Seed staging without exposing a partially copied file to the SDK."""
    destination.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(dir=destination.parent, prefix=".quarry-copy-")
    os.close(fd)
    temporary = Path(name)
    try:
        shutil.copy2(source, temporary)
        temporary.replace(destination)
    finally:
        temporary.unlink(missing_ok=True)


def _download_files(args, source: _ParsedUrl, files: list[str], token, selection: str, *, path_prefix: str = "") -> int:
    # Keep per-file progress bars from concurrent downloads off; we print ours.
    os.environ.setdefault("HF_HUB_DISABLE_PROGRESS_BARS", "1")
    from huggingface_hub import hf_hub_download
    from huggingface_hub.errors import EntryNotFoundError

    total = len(files)

    repo_name = source.repo_id.split("/")[-1]
    out_dir = Path(args.output_dir).expanduser() if args.output_dir else Path(repo_name)
    local_paths = {}
    for filename in files:
        relative = PurePosixPath(filename).relative_to(PurePosixPath(path_prefix))
        if relative.is_absolute() or ".." in relative.parts:
            raise SystemExit(f"error: invalid repository path: {filename!r}")
        local_paths[filename] = out_dir / relative
    # The SDK cannot rename remote paths. Keep its metadata and partial downloads
    # in a staging root, moving completed files to the selected-folder layout.
    # Scope staging by source so different folders/repos cannot reuse stale files.
    download_dir = out_dir
    if path_prefix:
        identity = repr((source.key(), path_prefix)).encode()
        download_dir = out_dir / ".cache" / "quarry" / hashlib.sha256(identity).hexdigest()[:16]
    endpoint = None if source.endpoint == _DEFAULT_ENDPOINT else source.endpoint
    workers = max(1, min(args.workers, total))
    token_source = (
        "$HF_TOKEN" if os.environ.get("HF_TOKEN") else "$HUGGINGFACE_HUB_TOKEN"
    ) if token else "SDK-managed (saved login or anonymous)"

    print(
        f"Repo:     {source.repo_id} [{source.repo_type or 'model'}] @ {source.revision}\n"
        f"{selection}\n"
        f"Output:   {out_dir.resolve()}\n"
        f"Token:    {token_source}\n"
        f"Workers:  {workers}",
        file=sys.stderr,
    )

    if args.dry_run:
        preview = files if total <= 12 else files[:6] + ["..."] + files[-6:]
        print("Dry run -- would download:", file=sys.stderr)
        for f in preview:
            target = f" -> {local_paths[f]}" if path_prefix and f != "..." else ""
            print(f"  {f}{target}", file=sys.stderr)
        print(f"({total} file(s) total; nothing downloaded)", file=sys.stderr)
        return 0

    out_dir.mkdir(parents=True, exist_ok=True)

    def download_one(filename: str):
        last_err = None
        for attempt in range(1, args.retries + 1):
            try:
                destination = local_paths[filename]
                staged = download_dir / filename
                if path_prefix and destination.is_file() and not staged.exists() and not args.force:
                    # copy2 retains mtime so SDK metadata still detects up-to-date
                    # files. A separate copy protects the output if an update fails.
                    _copy_atomic(destination, staged)
                downloaded = hf_hub_download(
                    repo_id=source.repo_id,
                    filename=filename,
                    repo_type=source.repo_type,
                    revision=source.revision,
                    local_dir=str(download_dir),
                    token=token,
                    endpoint=endpoint,
                    force_download=args.force,
                )
                if path_prefix:
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    Path(downloaded).replace(destination)
                return (filename, True, None)
            except EntryNotFoundError:
                return (filename, False, "not found in repo")
            except Exception as exc:  # transient network / rate-limit errors
                last_err = f"{type(exc).__name__}: {exc}"
                if attempt < args.retries:
                    time.sleep(2 * attempt)
        return (filename, False, last_err)

    done = ok = 0
    failures: list[tuple[str, str | None]] = []
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = {pool.submit(download_one, f): f for f in files}
        try:
            for fut in as_completed(futures):
                filename, success, err = fut.result()
                done += 1
                if success:
                    ok += 1
                else:
                    failures.append((filename, err))
                    print(f"\n  FAILED {filename}: {err}", file=sys.stderr)
                print(
                    f"\rProgress: {done}/{total}  ok={ok}  fail={len(failures)}",
                    end="", file=sys.stderr, flush=True,
                )
        except KeyboardInterrupt:
            print("\nInterrupted; cancelling pending downloads...", file=sys.stderr)
            for fut in futures:
                fut.cancel()
            raise

    print(file=sys.stderr)  # newline after the progress line
    if failures:
        print(f"Done with {len(failures)} failure(s):", file=sys.stderr)
        for filename, err in failures:
            print(f"  {filename}: {err}", file=sys.stderr)
        return 1
    print(f"Done: {ok}/{total} files downloaded to {out_dir.resolve()}", file=sys.stderr)
    return 0


def _extension(value: str) -> str:
    ext = value.removeprefix(".")
    if not ext or any(char in ext for char in "/\\*?[]") or not ext.strip("."):
        raise argparse.ArgumentTypeError("expected an extension such as parquet or .parquet")
    return "." + ext


def _positive_int(value: str) -> int:
    number = int(value)
    if number < 1:
        raise argparse.ArgumentTypeError("must be at least 1")
    return number


def _add_download_options(p) -> None:
    p.add_argument(
        "-o", "--output-dir", default=None,
        help="where to save files (default: ./<repo-name>)",
    )
    p.add_argument(
        "-w", "--workers", type=_positive_int, default=20,
        help="concurrent downloads (default: 20)",
    )
    p.add_argument(
        "--retries", type=_positive_int, default=3,
        help="attempts per file before giving up (default: 3)",
    )
    p.add_argument(
        "--force", action="store_true",
        help="re-download even if an up-to-date local copy exists",
    )
    p.add_argument(
        "--dry-run", action="store_true",
        help="print the planned file list and exit without downloading",
    )


def register(subparsers) -> None:
    p = subparsers.add_parser(
        "download-range",
        help="download a sequential range of files from a HF repo",
        description=_DOWNLOAD_RANGE_DESC,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    p.add_argument("url_start", help="resolve URL of the first file in the range")
    p.add_argument("url_end", help="resolve URL of the last file (inclusive)")
    _add_download_options(p)
    p.set_defaults(func=cmd_download_range)

    p = subparsers.add_parser(
        "download-folder",
        help="download a HF folder, optionally filtered by file extension",
        description=_DOWNLOAD_FOLDER_DESC,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    p.add_argument("url", help="HF tree URL of the folder to download")
    p.add_argument("--ext", type=_extension, help="file extension to include, e.g. parquet or .parquet")
    _add_download_options(p)
    p.set_defaults(func=cmd_download_folder)
