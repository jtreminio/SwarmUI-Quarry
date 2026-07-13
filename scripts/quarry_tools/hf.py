"""`quarry hf` subcommands: fetch datasets from the Hugging Face Hub.

download-range -- carried over from hf_download_range.py. huggingface_hub is
imported lazily inside the command function.
"""

from __future__ import annotations

import argparse
import os
import re
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
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
HUGGINGFACE_HUB_TOKEN). If neither is set, downloads proceed unauthenticated.

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
    parts = urlsplit(url)
    if not parts.scheme or not parts.netloc:
        raise SystemExit(f"error: not a valid URL: {url!r}")
    if "/resolve/" not in parts.path:
        raise SystemExit(f"error: not a HF resolve URL (no '/resolve/'): {url!r}")
    left, right = parts.path.split("/resolve/", 1)
    left_segs = left.strip("/").split("/")
    repo_type = None
    if left_segs and left_segs[0] in _URL_REPO_TYPE:
        repo_type = _URL_REPO_TYPE[left_segs[0]]
        repo_id = "/".join(left_segs[1:])
    else:
        repo_id = "/".join(left_segs)
    if repo_id.count("/") < 1:
        raise SystemExit(f"error: could not parse repo id from URL: {url!r}")

    right_segs = right.split("/")
    revision = unquote(right_segs[0])
    path = "/".join(right_segs[1:])
    if not path:
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
    # Keep per-file progress bars from 20 concurrent downloads off; we print ours.
    os.environ.setdefault("HF_HUB_DISABLE_PROGRESS_BARS", "1")
    from huggingface_hub import hf_hub_download
    from huggingface_hub.errors import EntryNotFoundError

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
    total = len(files)

    repo_name = start.repo_id.split("/")[-1]
    out_dir = Path(args.output_dir) if args.output_dir else Path(repo_name)
    out_dir.mkdir(parents=True, exist_ok=True)
    endpoint = None if start.endpoint == _DEFAULT_ENDPOINT else start.endpoint
    workers = max(1, min(args.workers, total))

    print(
        f"Repo:     {start.repo_id} [{start.repo_type or 'model'}] @ {start.revision}\n"
        f"Range:    {path_for(start_num)} .. {path_for(end_num)}  "
        f"({total} file(s), counter {start_num}->{end_num} width {width})\n"
        f"Output:   {out_dir.resolve()}\n"
        f"Token:    {'$HF_TOKEN' if token else 'none (unauthenticated / SDK cache)'}\n"
        f"Workers:  {workers}",
        file=sys.stderr,
    )

    if args.dry_run:
        preview = files if total <= 12 else files[:6] + ["..."] + files[-6:]
        print("Dry run -- would download:", file=sys.stderr)
        for f in preview:
            print(f"  {f}", file=sys.stderr)
        print(f"({total} file(s) total; nothing downloaded)", file=sys.stderr)
        return 0

    def download_one(filename: str):
        last_err = None
        for attempt in range(1, args.retries + 1):
            try:
                hf_hub_download(
                    repo_id=start.repo_id,
                    filename=filename,
                    repo_type=start.repo_type,
                    revision=start.revision,
                    local_dir=str(out_dir),
                    token=token,
                    endpoint=endpoint,
                    force_download=args.force,
                )
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


def register(subparsers) -> None:
    p = subparsers.add_parser(
        "download-range",
        help="download a sequential range of files from a HF repo",
        description=_DOWNLOAD_RANGE_DESC,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    p.add_argument("url_start", help="resolve URL of the first file in the range")
    p.add_argument("url_end", help="resolve URL of the last file (inclusive)")
    p.add_argument(
        "-o", "--output-dir", default=None,
        help="where to save files (default: ./<repo-name>)",
    )
    p.add_argument(
        "-w", "--workers", type=int, default=20,
        help="concurrent downloads (default: 20)",
    )
    p.add_argument(
        "--retries", type=int, default=3,
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
    p.set_defaults(func=cmd_download_range)
