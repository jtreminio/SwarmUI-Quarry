from __future__ import annotations

import hashlib
import json
import sys
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from urllib.parse import urlsplit

from .common import EXT_FORMAT_SHOW, atomic_output
from .storage import DESCRIPTOR, read_descriptor

DEFAULT_CATALOG = Path(__file__).resolve().parents[2] / "dataset-sources.json"
DEFAULT_REPO = "jtreminio/prompt-dataset"
UPLOAD_IGNORES = [".*", "**/.*", "**/.*/**"]


@dataclass(frozen=True)
class LocalDataset:
    name: str
    path: Path
    repo_path: str


def _valid_name(name) -> bool:
    return (isinstance(name, str) and bool(name) and "\\" not in name
            and all(part not in ("", ".", "..") and not part.startswith(".")
                    for part in name.split("/")))


def _valid_url(url) -> bool:
    if not isinstance(url, str) or any(c.isspace() for c in url):
        return False
    try:
        parsed = urlsplit(url)
        return (parsed.scheme in ("https", "http") and bool(parsed.hostname)
                and not parsed.username and not parsed.password)
    except ValueError:
        return False


def load_catalog(path: Path) -> list[dict]:
    if not path.exists():
        return []
    entries = json.loads(path.read_text())
    if not isinstance(entries, list):
        raise ValueError("source catalog must be a JSON array")
    names = set()
    for entry in entries:
        if not isinstance(entry, dict) or not _valid_name(entry.get("name")):
            raise ValueError("every catalog entry must have a valid dataset name")
        alias = entry.get("alias")
        if alias is not None and not _valid_name(alias):
            raise ValueError(f"invalid alias for {entry['name']}")
        if entry.get("sourceUrl") not in (None, "") and not _valid_url(entry["sourceUrl"]):
            raise ValueError(f"invalid source URL for {entry['name']}")
        for name in (entry["name"], alias):
            if name is None:
                continue
            if name.casefold() in names:
                raise ValueError(f"duplicate catalog name or alias: {name}")
            names.add(name.casefold())
    return entries


def catalog_lookup(entries: list[dict]) -> dict[str, dict]:
    lookup = {name.casefold(): entry for entry in entries
              for name in (entry["name"], entry.get("alias")) if name is not None}
    leaves = {}
    for name, entry in lookup.items():
        leaf = name.rsplit("/", 1)[-1]
        if leaf not in leaves:
            leaves[leaf] = entry
        elif leaves[leaf] is not entry:
            leaves[leaf] = None
    for leaf, entry in leaves.items():
        if entry is not None:
            lookup.setdefault(leaf, entry)
    return lookup


def save_catalog(path: Path, entries: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with atomic_output(path) as temporary:
        temporary.write_text(json.dumps(sorted(entries, key=lambda e: e["name"].casefold()), indent=4) + "\n")


def scan_datasets(root: Path, catalog: Path) -> list[LocalDataset]:
    if not root.is_dir():
        raise ValueError(f"local dataset directory does not exist: {root}")
    found = []

    def walk(directory: Path):
        for path in sorted(directory.iterdir()):
            if path.name.startswith(".") or path.resolve() == catalog.resolve():
                continue
            if path.is_symlink():
                raise ValueError(f"symlink in dataset directory: {path}")
            if path.is_dir():
                if path.suffix.lower() == ".lance":
                    files = list(path.rglob("*"))
                    if any(p.is_symlink() for p in files):
                        raise ValueError(f"symlink inside dataset: {path}")
                    if not any(p.is_file() for p in files):
                        raise ValueError(f"empty Lance dataset: {path}")
                    add(path)
                else:
                    walk(path)
            elif path.is_file() and path.suffix.lower() in EXT_FORMAT_SHOW and path.suffix.lower() != ".lance":
                add(path)

    def add(path: Path):
        relative = path.relative_to(root).as_posix()
        found.append(LocalDataset(relative.rsplit(".", 1)[0], path, relative))

    walk(root)
    names = set()
    for dataset in found:
        if dataset.name.casefold() in names:
            raise ValueError(f"multiple local formats map to dataset {dataset.name}")
        names.add(dataset.name.casefold())
    if not found:
        raise ValueError("no datasets found in the local directory; nothing uploaded or pruned")
    return found


def remote_datasets(files: list[str]) -> set[str]:
    datasets = set()
    for filename in files:
        parts = PurePosixPath(filename).parts
        if not parts or any(p.startswith(".") for p in parts) or filename == "dataset-sources.json":
            continue
        for i, part in enumerate(parts[:-1]):
            if part.lower().endswith(".lance"):
                datasets.add("/".join(parts[:i + 1]))
                break
        else:
            suffix = PurePosixPath(filename).suffix.lower()
            if suffix in EXT_FORMAT_SHOW and suffix != ".lance":
                datasets.add(filename)
    return datasets


def write_dataset_hash(directory: Path) -> str:
    descriptor = directory / DESCRIPTOR
    read_descriptor(directory)
    metadata = json.loads(descriptor.read_text(encoding="utf-8")) if descriptor.exists() else {"version": 1, "columns": {}}
    previous_hash = metadata.pop("datasetHash", None)
    entries = []
    for path in sorted(directory.rglob("*")):
        relative = path.relative_to(directory)
        if not path.is_file() or path == descriptor or any(part.startswith(".") for part in relative.parts):
            continue
        with path.open("rb") as file:
            digest = hashlib.file_digest(file, "sha256").hexdigest()
        entries.append([relative.as_posix(), digest])
    # Include storage metadata, but not the hash field itself.
    metadata_bytes = json.dumps(metadata, sort_keys=True, separators=(",", ":")).encode("utf-8")
    entries.append([DESCRIPTOR, hashlib.sha256(metadata_bytes).hexdigest()])
    digest = hashlib.sha256(json.dumps(sorted(entries), separators=(",", ":")).encode("utf-8")).hexdigest()
    if previous_hash == digest:
        return digest
    metadata["datasetHash"] = digest
    with atomic_output(descriptor) as temporary:
        temporary.write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf-8")
        temporary.chmod(descriptor.stat().st_mode & 0o777 if descriptor.exists() else 0o644)
    return digest


def infer_repo(name: str) -> str | None:
    source = next((part for part in name.split("/") if "." in part), "")
    parts = source.split(".")
    if len(parts) < 2 or not all(parts[:2]):
        return None
    return "/".join(parts[:2])


def _record_sources(datasets, entries, catalog, api, no_input: bool) -> int:
    known = catalog_lookup(entries)
    pending = []
    checked = {}
    for dataset in datasets:
        if dataset.name.casefold() in known:
            # A recorded empty source URL means "no source", not "unknown".
            continue
        repo = infer_repo(dataset.name)
        url = None
        if repo:
            if repo not in checked:
                try:
                    api.repo_info(repo_id=repo, repo_type="dataset", timeout=15)
                    checked[repo] = True
                except Exception as exc:
                    print(f"Could not verify {repo}: {type(exc).__name__}: {exc}", file=sys.stderr)
                    checked[repo] = False
            if checked[repo]:
                url = f"https://huggingface.co/datasets/{repo}"
        if url is None:
            pending.append(dataset.name)
            continue
        entries.append({"name": dataset.name, "alias": None, "sourceUrl": url})
        save_catalog(catalog, entries)
        print(f"Verified source: {dataset.name} -> {url}", file=sys.stderr)

    if no_input:
        for name in pending:
            print(f"Source still needed: {name}", file=sys.stderr)
        return 2 if pending else 0
    for index, name in enumerate(pending, 1):
        while True:
            try:
                answer = input(f"[{index}/{len(pending)}] Origin URL for {name} (NONE for no source): ").strip()
            except (EOFError, KeyboardInterrupt):
                print("\nSource entry interrupted. Saved answers are kept; rerun sync to finish the remaining names.", file=sys.stderr)
                return 2
            if answer.casefold() == "none":
                url = None
                break
            if _valid_url(answer):
                url = answer
                break
            print("Enter a full http(s) URL or NONE.", file=sys.stderr)
        entries.append({"name": name, "alias": None, "sourceUrl": url})
        save_catalog(catalog, entries)
    return 0


def cmd_sync(args) -> int:
    from huggingface_hub import CommitOperationDelete, HfApi
    from .hf import _resolve_token

    root = Path(args.directory).expanduser().resolve()
    catalog = Path(args.catalog).expanduser().resolve()
    try:
        entries = load_catalog(catalog)
        datasets = scan_datasets(root, catalog)
        if not catalog.parent.is_dir():
            raise ValueError(f"catalog parent directory does not exist: {catalog.parent}")
        api = HfApi(token=_resolve_token())
        snapshot = api.repo_info(repo_id=args.repo, repo_type="dataset", revision=args.revision).sha
        local_paths = {d.repo_path for d in datasets}
        print(f"Sync {root} -> {args.repo} @ {args.revision}: {len(datasets)} dataset(s)", file=sys.stderr)
        if args.dry_run:
            remote = remote_datasets(api.list_repo_files(repo_id=args.repo, repo_type="dataset", revision=snapshot))
            for dataset in datasets:
                status = "NEW" if dataset.repo_path not in remote else "EXISTING"
                print(f"  Upload [{status}] {dataset.repo_path}", file=sys.stderr)
            print(f"New datasets: {len(local_paths - remote)}; already on HF: {len(local_paths & remote)}", file=sys.stderr)
            if args.prune:
                for path in sorted(remote - local_paths):
                    print(f"  Prune {path}", file=sys.stderr)
            known = catalog_lookup(entries)
            for dataset in datasets:
                if dataset.name.casefold() not in known:
                    print(f"  New source to check: {dataset.name}", file=sys.stderr)
            print("Dry run: no uploads, deletions, catalog edits, or prompts.", file=sys.stderr)
            return 0
        for dataset in datasets:
            print(f"  Upload {dataset.repo_path}", file=sys.stderr)
            kwargs = dict(repo_id=args.repo, repo_type="dataset", revision=args.revision,
                          commit_message=f"Sync {dataset.name}")
            if dataset.path.is_dir():
                print(f"  Hashing {dataset.repo_path}", file=sys.stderr)
                write_dataset_hash(dataset.path)
                api.upload_folder(folder_path=str(dataset.path), path_in_repo=dataset.repo_path,
                                  ignore_patterns=UPLOAD_IGNORES, **kwargs)
            else:
                api.upload_file(path_or_fileobj=str(dataset.path), path_in_repo=dataset.repo_path, **kwargs)
        print("All dataset uploads completed.", file=sys.stderr)
        if args.prune:
            # HF rejects parent_commit deletions if the branch changes after this snapshot.
            snapshot = api.repo_info(repo_id=args.repo, repo_type="dataset", revision=args.revision).sha
            remote = remote_datasets(api.list_repo_files(repo_id=args.repo, repo_type="dataset", revision=snapshot))
            removed = sorted(remote - local_paths)
            if removed:
                print("Pruning absent remote datasets:\n  " + "\n  ".join(removed), file=sys.stderr)
                api.create_commit(repo_id=args.repo, repo_type="dataset", revision=args.revision,
                                  parent_commit=snapshot, commit_message="Prune datasets absent from local Quarry directory",
                                  operations=[CommitOperationDelete(path_in_repo=path, is_folder=path.lower().endswith(".lance"))
                                              for path in removed])
        result = _record_sources(datasets, entries, catalog, api, args.no_input)
        print(f"Source catalog: {catalog}", file=sys.stderr)
        return result
    except KeyboardInterrupt:
        print("\nSync interrupted. Rerun to resume uploads and source recording.", file=sys.stderr)
        return 130
    except Exception as exc:
        print(f"error: sync failed: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 1


def register(subparsers) -> None:
    parser = subparsers.add_parser(
        "sync", help="upload local Quarry datasets and record their original sources",
        description="Upload datasets to an existing Hugging Face dataset repo. After uploads finish, "
                    "verify inferred sources for new catalog names and prompt for unresolved URLs. "
                    "Enter NONE to record that a dataset has no source URL.",
    )
    parser.add_argument("directory", help="local Quarry dataset directory")
    parser.add_argument("--repo", default=DEFAULT_REPO, help=f"destination dataset repository (default: {DEFAULT_REPO})")
    parser.add_argument("--revision", default="main", help="destination branch (default: main)")
    parser.add_argument("--catalog", default=str(DEFAULT_CATALOG), help="source JSON file (default: this extension's dataset-sources.json)")
    parser.add_argument("--prune", action="store_true", help="after uploading, delete remote datasets absent locally; keep repo metadata")
    parser.add_argument("--dry-run", action="store_true", help="preview uploads, optional pruning, and new catalog names without making changes")
    parser.add_argument("--no-input", action="store_true", help="save verified sources; leave unresolved names unrecorded and exit 2 instead of prompting")
    parser.set_defaults(func=cmd_sync)
