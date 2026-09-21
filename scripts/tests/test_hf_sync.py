import io
import json
import shutil
import sys
import tempfile
import threading
import unittest
import zipfile
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from huggingface_hub import CommitOperationAdd, CommitOperationDelete
from huggingface_hub.errors import RemoteEntryNotFoundError
import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from quarry_tools.cli import main
from quarry_tools.hf_sync import catalog_lookup, load_catalog, remote_datasets, write_dataset_hash
from quarry_tools.storage import DESCRIPTOR, read_descriptor


class SyncTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.work = Path(directory.name)
        self.local = self.work / "datasets"
        self.local.mkdir()
        self.catalog = self.work / "sources.json"
        self.events = []
        api_patch = patch("huggingface_hub.HfApi", autospec=True)
        self.api_class = api_patch.start()
        self.addCleanup(api_patch.stop)
        self.api = self.api_class.return_value
        self.api.repo_info.side_effect = self.repo_info
        self.lance_commits = Mock(side_effect=self.upload_commit)
        self.prune_commits = Mock(side_effect=self.prune_commit)
        self.api.create_commit.side_effect = lambda **kw: (
            self.lance_commits(**kw) if kw["commit_message"].startswith("Sync ") else self.prune_commits(**kw))
        self.api.upload_file.side_effect = self.upload_file
        self.api.list_repo_files.return_value = []
        self.remote_descriptors = {}
        self.api.hf_hub_download.side_effect = self.download_descriptor
        self.source_error = None
        self.answers = []
        input_patch = patch("builtins.input", side_effect=self.answer)
        self.input = input_patch.start()
        self.addCleanup(input_patch.stop)

    def upload_commit(self, **kwargs):
        self.events.append(("upload", kwargs["commit_message"][5:] + ".lance"))
        return SimpleNamespace(oid="uploaded-sha")

    def upload_file(self, **kwargs):
        self.events.append(("upload", kwargs["path_in_repo"]))
        return SimpleNamespace(oid="uploaded-sha")

    def prune_commit(self, **kwargs):
        self.events.append(("prune", kwargs))
        return SimpleNamespace(oid="pruned-sha")

    def download_descriptor(self, **kwargs):
        filename = kwargs["filename"]
        if filename not in self.remote_descriptors:
            raise RemoteEntryNotFoundError("descriptor not found", response=httpx.Response(
                404, request=httpx.Request("GET", "https://huggingface.co/descriptor")))
        return str(self.remote_descriptors[filename])

    def remote_descriptor(self, repo_path, contents):
        filename = f"{repo_path}/{DESCRIPTOR}"
        path = self.work / "remote" / filename
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(contents)
        self.remote_descriptors[filename] = path
        # Model a complete published copy by default, not just its descriptor.
        local = self.local / repo_path
        files = ([f"{repo_path}/{p.relative_to(local).as_posix()}" for p in local.rglob("*") if p.is_file()]
                 if local.is_dir() else [filename])
        self.api.list_repo_files.return_value = sorted(set(self.api.list_repo_files.return_value + files))

    def repo_info(self, **kwargs):
        if kwargs["repo_id"] == "owner/collection":
            return SimpleNamespace(sha="snapshot-sha")
        self.events.append(("verify", kwargs["repo_id"]))
        if self.source_error:
            raise self.source_error
        return SimpleNamespace(sha="origin-sha")

    def answer(self, prompt):
        self.events.append(("prompt", prompt))
        if not self.answers:
            raise EOFError()
        answer = self.answers.pop(0)
        if isinstance(answer, BaseException):
            raise answer
        return answer

    def dataset(self, path="tags/org.repo.lance"):
        target = self.local / path
        if path.endswith(".lance"):
            target = target / "data" / "part.lance"
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text("data")
        return target

    def write_catalog(self, entries):
        self.catalog.write_text(json.dumps(entries))

    def run_cli(self, *options, directory=None):
        output = io.StringIO()
        with redirect_stderr(output), redirect_stdout(output):
            result = main(["hf", "sync", str(directory or self.local), "--repo=owner/collection",
                           "--catalog", str(self.catalog), *options])
        return result, output.getvalue()

    def test_direct_lance_directory_uploads_once_and_records_dataset_source(self):
        part = self.dataset("tags/jgreely.c1ga.lance")
        directory = part.parent.parent
        (directory / "_versions").mkdir()
        (directory / "_versions/latest_version_hint.json").write_text('{"version": 1}')
        (directory / DESCRIPTOR).write_text('{"version": 1, "columns": {}}')
        self.dataset("tags/other.dataset.lance")

        result, output = self.run_cli(directory=str(directory) + "/")

        self.assertEqual(result, 0, output)
        self.assertIn("1 dataset(s)", output)
        self.api.upload_file.assert_not_called()
        self.lance_commits.assert_called_once()
        kwargs = self.lance_commits.call_args.kwargs
        self.assertEqual(kwargs["parent_commit"], "snapshot-sha")
        self.assertEqual(kwargs["commit_message"], "Sync jgreely.c1ga")
        self.assertEqual({op.path_in_repo for op in kwargs["operations"]}, {
            "jgreely.c1ga.lance/data/part.lance", "jgreely.c1ga.lance/quarry-storage.json",
            "jgreely.c1ga.lance/_versions/latest_version_hint.json"})
        self.assertEqual(len(json.loads((directory / DESCRIPTOR).read_text())["datasetHash"]), 64)
        self.assertEqual(load_catalog(self.catalog), [
            {"name": "jgreely.c1ga", "alias": None,
             "sourceUrl": "https://huggingface.co/datasets/jgreely/c1ga"},
        ])
        self.input.assert_not_called()

    def test_direct_lance_dry_run_previews_dataset_without_changing_files(self):
        part = self.dataset()
        directory = part.parent.parent
        directory = directory.rename(directory.with_suffix(".LANCE"))
        self.api.list_repo_files.return_value = ["org.repo.LANCE/data/part.lance"]

        result, output = self.run_cli("--dry-run", directory=directory)

        self.assertEqual(result, 0, output)
        self.assertIn("Upload [EXISTING] org.repo.LANCE", output)
        self.assertIn("New datasets: 0; already on HF: 1", output)
        self.assertIn("New source to check: org.repo", output)
        self.assertFalse((directory / DESCRIPTOR).exists())
        self.assertFalse(self.catalog.exists())
        self.lance_commits.assert_not_called()
        self.api.upload_file.assert_not_called()
        self.input.assert_not_called()

    def test_direct_empty_or_symlink_containing_lance_fails_before_api(self):
        for case in ("empty", "symlink"):
            with self.subTest(case=case):
                directory = self.local / f"{case}.lance"
                directory.mkdir()
                if case == "symlink":
                    (directory / "linked").symlink_to(self.work, target_is_directory=True)
                result, output = self.run_cli(directory=directory)
                self.assertEqual(result, 1, output)
                self.assertIn("empty Lance dataset" if case == "empty" else "symlink inside dataset", output)
                self.api_class.assert_not_called()

    def test_uploads_all_before_verification_and_infers_subset_repo(self):
        self.dataset("tags/org.repo.one.lance")
        self.dataset("tags/org.repo.two.lance")
        result, output = self.run_cli()
        self.assertEqual(result, 0, output)
        self.assertEqual([e[0] for e in self.events], ["upload", "upload", "verify"])
        self.assertEqual(self.events[-1], ("verify", "org/repo"))
        self.assertEqual([e["sourceUrl"] for e in load_catalog(self.catalog)],
                         ["https://huggingface.co/datasets/org/repo"] * 2)
        for entry in load_catalog(self.catalog):
            self.assertIsNone(entry["alias"])
            self.assertNotIn("aliases", entry)
        self.assertFalse(self.input.called)
        kwargs = self.lance_commits.call_args.kwargs
        self.assertEqual(kwargs["parent_commit"], "uploaded-sha")
        self.assertEqual(kwargs["commit_message"], "Sync tags/org.repo.two")
        self.assertTrue(all(op.path_in_repo.startswith("tags/org.repo.two.lance/")
                            for op in kwargs["operations"]))

    def test_sync_publishes_hash_in_existing_storage_metadata(self):
        part = self.dataset()
        directory = part.parent.parent
        metadata = {"version": 1, "columns": {"prompt": "prompt__case"},
                    "optimized": {"version": 1, "lance_version": 3}}
        (directory / DESCRIPTOR).write_text(json.dumps(metadata))
        uploaded = []
        def capture(**kwargs):
            descriptor = next(op for op in kwargs["operations"] if op.path_in_repo.endswith("/" + DESCRIPTOR))
            uploaded.append(json.loads(Path(descriptor.path_or_fileobj).read_text()))
            return self.upload_commit(**kwargs)
        self.lance_commits.side_effect = capture
        result, output = self.run_cli()
        self.assertEqual(result, 0, output)
        self.assertEqual(len(uploaded[0]["datasetHash"]), 64)
        self.assertEqual({k: v for k, v in uploaded[0].items() if k != "datasetHash"}, metadata)
        self.assertEqual(read_descriptor(directory), metadata["columns"])

    def test_hash_is_stable_across_reruns_renames_and_hidden_cache_changes(self):
        part = self.dataset()
        directory = part.parent.parent
        original = write_dataset_hash(directory)
        self.assertEqual(write_dataset_hash(directory), original)
        hidden = directory / ".cache" / "huggingface" / "upload.json"
        hidden.parent.mkdir(parents=True)
        hidden.write_text("local cache")
        self.assertEqual(write_dataset_hash(directory), original)
        renamed = directory.with_name("org.renamed.lance")
        directory.rename(renamed)
        self.assertEqual(write_dataset_hash(renamed), original)
        metadata = json.loads((renamed / DESCRIPTOR).read_text())
        metadata["datasetHash"] = "ignored old hash"
        (renamed / DESCRIPTOR).write_text(json.dumps(metadata, indent=4))
        self.assertEqual(write_dataset_hash(renamed), original)

    def test_matching_hash_skips_upload_and_still_records_source(self):
        directory = self.dataset().parent.parent
        write_dataset_hash(directory)
        before = (directory / DESCRIPTOR).read_bytes()
        self.remote_descriptor("tags/org.repo.lance", before.decode())

        result, output = self.run_cli("--revision", "publish")

        self.assertEqual(result, 0, output)
        self.assertIn("Skip [UNCHANGED] tags/org.repo.lance", output)
        self.assertIn("0 uploaded; 1 skipped unchanged", output)
        self.lance_commits.assert_not_called()
        self.api.upload_file.assert_not_called()
        self.api.hf_hub_download.assert_called_once_with(
            repo_id="owner/collection", repo_type="dataset", revision="snapshot-sha",
            filename="tags/org.repo.lance/quarry-storage.json")
        self.assertEqual((directory / DESCRIPTOR).read_bytes(), before)
        self.assertEqual(load_catalog(self.catalog)[0]["name"], "tags/org.repo")

    def test_mixed_collection_uploads_only_changed_new_and_single_file_datasets(self):
        for name in ("same", "changed", "new"):
            directory = self.dataset(f"tags/org.{name}.lance").parent.parent
            write_dataset_hash(directory)
            if name == "same":
                self.remote_descriptor(f"tags/org.{name}.lance", (directory / DESCRIPTOR).read_text())
            elif name == "changed":
                self.remote_descriptor(f"tags/org.{name}.lance", json.dumps({"datasetHash": "0" * 64}))
        self.dataset("tags/org.file.csv")

        result, output = self.run_cli()

        self.assertEqual(result, 0, output)
        self.assertEqual([call.kwargs["commit_message"] for call in self.lance_commits.call_args_list],
                         ["Sync tags/org.changed", "Sync tags/org.new"])
        self.api.upload_file.assert_called_once()
        self.assertEqual(self.api.upload_file.call_args.kwargs["path_in_repo"], "tags/org.file.csv")
        self.assertIn("3 uploaded; 1 skipped unchanged", output)

    def test_matching_hash_with_stale_files_repairs_in_one_scoped_commit(self):
        directory = self.dataset().parent.parent
        manifest = directory / "_versions/18446744073709551613.manifest"
        manifest.parent.mkdir()
        manifest.write_text("current version 2")
        hidden = directory / ".cache/upload.json"
        hidden.parent.mkdir()
        hidden.write_text("local cache")
        write_dataset_hash(directory)
        before = {p: p.read_bytes() for p in directory.rglob("*") if p.is_file()}
        self.remote_descriptor("tags/org.repo.lance", (directory / DESCRIPTOR).read_text())
        # Hidden local files never belong in the published snapshot.
        self.api.list_repo_files.return_value.remove("tags/org.repo.lance/.cache/upload.json")
        stale = {"tags/org.repo.lance/_versions/18446744073709551604.manifest",
                 "tags/org.repo.lance/data/old.lance", "tags/org.repo.lance/_indices/old/index.lance"}
        unrelated = {"tags/org.repo.lance-other/data/keep.lance", "tags/other.lance/data/keep.lance",
                     "README.md", ".gitattributes", "dataset-sources.json"}
        self.api.list_repo_files.return_value.extend(stale | unrelated)

        result, output = self.run_cli("--revision", "publish")

        self.assertEqual(result, 0, output)
        self.assertIn("Repair [FILE SET] tags/org.repo.lance: 3 obsolete, 0 missing", output)
        self.api.create_commit.assert_called_once()
        self.api.upload_folder.assert_not_called()
        kwargs = self.api.create_commit.call_args.kwargs
        self.assertEqual(kwargs["revision"], "publish")
        self.assertEqual(kwargs["parent_commit"], "snapshot-sha")
        deletions = {op.path_in_repo for op in kwargs["operations"] if isinstance(op, CommitOperationDelete)}
        additions = {op.path_in_repo for op in kwargs["operations"] if isinstance(op, CommitOperationAdd)}
        self.assertEqual(deletions, stale)
        self.assertEqual(additions, {"tags/org.repo.lance/data/part.lance",
                                     "tags/org.repo.lance/_versions/18446744073709551613.manifest",
                                     "tags/org.repo.lance/quarry-storage.json"})
        self.assertTrue(all(not op.is_folder for op in kwargs["operations"] if isinstance(op, CommitOperationDelete)))
        self.assertEqual({p: p.read_bytes() for p in before}, before)
        self.prune_commits.assert_not_called()

    def test_matching_hash_with_missing_file_is_not_skipped(self):
        directory = self.dataset().parent.parent
        write_dataset_hash(directory)
        self.remote_descriptor("tags/org.repo.lance", (directory / DESCRIPTOR).read_text())
        self.api.list_repo_files.return_value.remove("tags/org.repo.lance/data/part.lance")

        result, output = self.run_cli()

        self.assertEqual(result, 0, output)
        self.assertIn("Repair [FILE SET] tags/org.repo.lance: 0 obsolete, 1 missing", output)
        self.api.create_commit.assert_called_once()
        self.assertTrue(all(isinstance(op, CommitOperationAdd)
                            for op in self.api.create_commit.call_args.kwargs["operations"]))

    def test_dry_run_reports_stale_files_despite_matching_hash_without_mutations(self):
        directory = self.dataset().parent.parent
        write_dataset_hash(directory)
        self.remote_descriptor("tags/org.repo.lance", (directory / DESCRIPTOR).read_text())
        stale = "tags/org.repo.lance/_versions/old.manifest"
        self.api.list_repo_files.return_value.append(stale)
        before = {p: p.read_bytes() for p in directory.rglob("*") if p.is_file()}

        result, output = self.run_cli("--dry-run")

        self.assertEqual(result, 0, output)
        self.assertIn("Repair [FILE SET]", output)
        self.assertIn(f"Remove obsolete file {stale}", output)
        self.assertIn("Would upload: 1; skipped unchanged: 0", output)
        self.assertIn("Would remove obsolete files inside uploaded datasets: 1", output)
        self.assertEqual({p: p.read_bytes() for p in before}, before)
        self.api.create_commit.assert_not_called()
        self.api.upload_folder.assert_not_called()
        self.api.upload_file.assert_not_called()
        self.input.assert_not_called()
        self.assertFalse(self.catalog.exists())

    def test_upload_conflict_stops_without_unconditional_retry_or_prune(self):
        self.dataset("tags/org.first.lance")
        self.dataset("tags/org.second.lance")
        self.lance_commits.side_effect = RuntimeError("parent commit changed")

        result, output = self.run_cli("--prune")

        self.assertEqual(result, 1, output)
        self.assertIn("parent commit changed", output)
        self.api.create_commit.assert_called_once()
        self.assertEqual(self.api.create_commit.call_args.kwargs["parent_commit"], "snapshot-sha")
        self.api.upload_folder.assert_not_called()
        self.prune_commits.assert_not_called()
        self.input.assert_not_called()
        self.assertFalse(self.catalog.exists())

    def test_parent_commit_advances_after_both_single_file_and_lance_uploads(self):
        self.dataset("tags/org.first.csv")
        self.dataset("tags/org.second.lance")
        self.dataset("tags/org.third.lance")
        self.api.upload_file.side_effect = None
        self.api.upload_file.return_value = SimpleNamespace(oid="file-sha")
        self.lance_commits.side_effect = [SimpleNamespace(oid="second-sha"), SimpleNamespace(oid="third-sha")]

        result, output = self.run_cli()

        self.assertEqual(result, 0, output)
        self.assertEqual(self.api.upload_file.call_args.kwargs["parent_commit"], "snapshot-sha")
        self.assertEqual([call.kwargs["parent_commit"] for call in self.lance_commits.call_args_list],
                         ["file-sha", "second-sha"])
        self.assertTrue(all(call.kwargs["revision"] == "snapshot-sha"
                            for call in self.api.hf_hub_download.call_args_list))

    def test_inventory_lookup_failure_stops_before_hashing_or_writes(self):
        directory = self.dataset().parent.parent
        self.api.list_repo_files.side_effect = RuntimeError("listing failed")

        result, output = self.run_cli("--prune")

        self.assertEqual(result, 1, output)
        self.assertIn("listing failed", output)
        self.assertFalse((directory / DESCRIPTOR).exists())
        self.api.create_commit.assert_not_called()
        self.api.upload_file.assert_not_called()
        self.input.assert_not_called()

    def test_real_lance_snapshot_recovers_from_higher_version_legacy_manifest(self):
        import lance
        import pyarrow as pa
        from quarry_tools.storage import logical_reader

        extracted = self.work / "fixture"
        with zipfile.ZipFile(Path(__file__).resolve().parents[2] / "Tests/Fixtures/lance-v22.zip") as archive:
            archive.extractall(extracted)
        directory = self.local / "tags/org.repo.lance"
        directory.parent.mkdir()
        shutil.copytree(extracted / "sample.lance", directory)
        write_dataset_hash(directory)
        current = lance.dataset(directory)
        expected = logical_reader(current, directory).read_all()

        # Model the original additive upload: old high-version files survive
        # alongside the rebuilt low-version data and matching new descriptor.
        published_root = self.work / "published"
        published = published_root / "tags/org.repo.lance"
        legacy = pa.table({"prompt": ["Legacy Prompt"], "prompt__lc": ["legacy prompt"]})
        for version in range(current.version + 1):
            lance.write_dataset(legacy, published, mode="create" if version == 0 else "overwrite")
        shutil.copytree(directory, published, dirs_exist_ok=True)
        self.assertGreater(lance.dataset(published).version, current.version)
        self.assertNotIn("prompt__case", lance.dataset(published).schema.names)
        self.remote_descriptors["tags/org.repo.lance/" + DESCRIPTOR] = published / DESCRIPTOR
        self.api.list_repo_files.return_value = [p.relative_to(published_root).as_posix()
                                                 for p in published.rglob("*") if p.is_file()]

        def publish(**kwargs):
            for operation in kwargs["operations"]:
                target = published_root / operation.path_in_repo
                if isinstance(operation, CommitOperationDelete):
                    target.unlink()
                else:
                    target.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copyfile(operation.path_or_fileobj, target)
            return self.upload_commit(**kwargs)

        self.lance_commits.side_effect = publish
        result, output = self.run_cli()

        self.assertEqual(result, 0, output)
        self.assertIn("Repair [FILE SET]", output)
        self.api.create_commit.assert_called_once()
        recovered = lance.dataset(published)
        self.assertEqual(recovered.version, current.version)
        self.assertEqual(logical_reader(recovered, published).read_all(), expected)
        self.assertEqual(write_dataset_hash(published, persist=False), write_dataset_hash(directory, persist=False))

        # Once repaired, an unchanged rerun truly skips publication.
        self.api.list_repo_files.return_value = [p.relative_to(published_root).as_posix()
                                                 for p in published.rglob("*") if p.is_file()]
        self.api.create_commit.reset_mock()
        result, output = self.run_cli()
        self.assertEqual(result, 0, output)
        self.assertIn("Skip [UNCHANGED]", output)
        self.api.create_commit.assert_not_called()

    def test_stale_local_hash_cannot_hide_content_or_metadata_edits(self):
        for change in ("content", "metadata"):
            with self.subTest(change=change):
                part = self.dataset(f"tags/org.{change}.lance")
                directory = part.parent.parent
                previous = write_dataset_hash(directory)
                self.remote_descriptor(directory.name, (directory / DESCRIPTOR).read_text())
                if change == "content":
                    part.write_text("DATA")
                else:
                    metadata = json.loads((directory / DESCRIPTOR).read_text())
                    metadata["optimized"] = {"version": 1, "lance_version": 2}
                    (directory / DESCRIPTOR).write_text(json.dumps(metadata))
                self.lance_commits.reset_mock()

                result, output = self.run_cli(directory=directory)

                self.assertEqual(result, 0, output)
                self.lance_commits.assert_called_once()
                self.assertNotEqual(json.loads((directory / DESCRIPTOR).read_text())["datasetHash"], previous)

    def test_missing_or_invalid_remote_hash_never_skips_upload(self):
        directory = self.dataset().parent.parent
        for contents in ('{}', '{"datasetHash": null}', '{"datasetHash": ""}',
                         '{"datasetHash": "invalid"}', json.dumps({"datasetHash": "x" * 64}),
                         '{"datasetHash": 123}', '[]', 'not json'):
            with self.subTest(contents=contents):
                self.remote_descriptor("tags/org.repo.lance", contents)
                self.lance_commits.reset_mock()
                result, output = self.run_cli()
                self.assertEqual(result, 0, output)
                self.lance_commits.assert_called_once()

    def test_dry_run_compares_fresh_hashes_without_writing_local_changes(self):
        descriptors = {}
        for name in ("same", "changed"):
            part = self.dataset(f"tags/org.{name}.lance")
            directory = part.parent.parent
            write_dataset_hash(directory)
            descriptor = directory / DESCRIPTOR
            descriptors[descriptor] = descriptor.read_bytes()
            self.remote_descriptor(f"tags/org.{name}.lance", descriptor.read_text())
            if name == "changed":
                part.write_text("changed")

        result, output = self.run_cli("--dry-run")

        self.assertEqual(result, 0, output)
        self.assertIn("Skip [UNCHANGED] tags/org.same.lance", output)
        self.assertIn("Upload [EXISTING] tags/org.changed.lance", output)
        self.assertIn("Would upload: 1; skipped unchanged: 1", output)
        self.assertEqual({path: path.read_bytes() for path in descriptors}, descriptors)
        self.assertFalse(self.catalog.exists())
        self.lance_commits.assert_not_called()
        self.api.upload_file.assert_not_called()
        self.prune_commits.assert_not_called()
        self.input.assert_not_called()

    def test_skipped_dataset_is_kept_when_pruning(self):
        directory = self.dataset().parent.parent
        write_dataset_hash(directory)
        self.remote_descriptor("tags/org.repo.lance", (directory / DESCRIPTOR).read_text())
        self.api.list_repo_files.return_value.append("gone.lance/data/old.lance")

        result, output = self.run_cli("--prune")

        self.assertEqual(result, 0, output)
        self.lance_commits.assert_not_called()
        operations = self.prune_commits.call_args.kwargs["operations"]
        self.assertEqual([op.path_in_repo for op in operations], ["gone.lance"])

    def test_descriptor_download_failure_stops_before_upload_prune_or_source_edits(self):
        self.dataset()
        self.api.hf_hub_download.side_effect = RuntimeError("connection failed")

        result, output = self.run_cli("--prune")

        self.assertEqual(result, 1, output)
        self.assertIn("connection failed", output)
        self.lance_commits.assert_not_called()
        self.prune_commits.assert_not_called()
        self.input.assert_not_called()
        self.assertFalse(self.catalog.exists())

    def test_failed_upload_is_retried_despite_updated_local_hash(self):
        part = self.dataset()
        directory = part.parent.parent
        write_dataset_hash(directory)
        self.remote_descriptor("tags/org.repo.lance", (directory / DESCRIPTOR).read_text())
        part.write_text("changed")
        self.lance_commits.side_effect = [RuntimeError("upload failed"), SimpleNamespace(oid="uploaded-sha")]

        self.assertEqual(self.run_cli()[0], 1)
        result, output = self.run_cli()

        self.assertEqual(result, 0, output)
        self.assertEqual(self.lance_commits.call_count, 2)

    def test_hashing_runs_concurrently_with_configured_worker_limit(self):
        for name in ("one", "two", "three", "four"):
            self.dataset(f"tags/org.{name}.lance")
        for workers in (1, 2):
            with self.subTest(workers=workers):
                barrier = threading.Barrier(workers)
                lock = threading.Lock()
                active = peak = 0

                def hash_one(directory, *, persist=True):
                    nonlocal active, peak
                    with lock:
                        active += 1
                        peak = max(peak, active)
                    try:
                        barrier.wait(timeout=5)
                        return write_dataset_hash(directory, persist=persist)
                    finally:
                        with lock:
                            active -= 1

                with patch("quarry_tools.hf_sync.write_dataset_hash", side_effect=hash_one) as hashing:
                    result, output = self.run_cli("--hash-workers", str(workers))
                self.assertEqual(result, 0, output)
                self.assertEqual(hashing.call_count, 4)
                self.assertEqual(peak, workers)

    def test_hash_failure_prevents_uploads_pruning_and_source_edits(self):
        self.dataset()
        with patch("quarry_tools.hf_sync.write_dataset_hash", side_effect=OSError("read failed")):
            result, output = self.run_cli("--prune")
        self.assertEqual(result, 1, output)
        self.assertIn("read failed", output)
        self.lance_commits.assert_not_called()
        self.prune_commits.assert_not_called()
        self.input.assert_not_called()
        self.assertFalse(self.catalog.exists())

    def test_nonpositive_hash_worker_count_is_rejected(self):
        self.dataset()
        for workers in ("0", "-1"):
            with self.subTest(workers=workers), self.assertRaises(SystemExit) as error:
                self.run_cli("--hash-workers", workers)
            self.assertEqual(error.exception.code, 2)
        self.api_class.assert_not_called()

    def test_hash_changes_with_contents_paths_and_storage_metadata(self):
        part = self.dataset()
        directory = part.parent.parent
        original = write_dataset_hash(directory)
        part.write_text("DATA")
        modified = write_dataset_hash(directory)
        self.assertNotEqual(modified, original)
        part.rename(part.with_name("optimized.lance"))
        renamed = write_dataset_hash(directory)
        self.assertNotEqual(renamed, modified)
        metadata = json.loads((directory / DESCRIPTOR).read_text())
        metadata["optimized"] = {"version": 1, "lance_version": 3}
        (directory / DESCRIPTOR).write_text(json.dumps(metadata))
        self.assertNotEqual(write_dataset_hash(directory), renamed)

    def test_existing_null_empty_and_missing_urls_never_prompt_or_infer(self):
        entries = [{"name": "tags/org.one", "sourceUrl": None},
                   {"name": "tags/org.two", "sourceUrl": ""},
                   {"name": "tags/org.three"}]
        for e in entries:
            self.dataset(e["name"] + ".lance")
        self.write_catalog(entries)
        before = self.catalog.read_bytes()
        result, output = self.run_cli()
        self.assertEqual(result, 0, output)
        self.assertEqual(self.catalog.read_bytes(), before)
        self.assertTrue(all(e[0] == "upload" for e in self.events))
        self.input.assert_not_called()

    def test_known_alias_preserves_explicit_attribution_and_metadata(self):
        self.dataset("nl/jgreely-c1ga.lance")
        entries = [{"name": "nl/jgreely.c1ga", "alias": "nl/jgreely-c1ga",
                    "sourceUrl": "https://github.com/jgreely/c1ga", "note": "manual"}]
        self.write_catalog(entries)
        result, output = self.run_cli()
        self.assertEqual(result, 0, output)
        self.assertEqual(load_catalog(self.catalog), entries)
        self.input.assert_not_called()

    def test_missing_origin_prompts_after_uploads_and_none_is_persistent(self):
        self.dataset("tags/one.lance")
        self.dataset("tags/two.lance")
        self.answers = ["NONE", "none"]
        result, output = self.run_cli()
        self.assertEqual(result, 0, output)
        self.assertEqual([e[0] for e in self.events], ["upload", "upload", "prompt", "prompt"])
        self.assertEqual([e["sourceUrl"] for e in load_catalog(self.catalog)], [None, None])
        self.input.reset_mock()
        self.assertEqual(self.run_cli()[0], 0)
        self.input.assert_not_called()

    def test_failed_verification_accepts_manual_url_and_reprompts_invalid_answers(self):
        self.dataset()
        self.source_error = RuntimeError("repo unavailable")
        self.answers = ["", "not a URL", "https://user:secret@example.com", "https://github.com/team/project"]
        result, output = self.run_cli()
        self.assertEqual(result, 0, output)
        self.assertEqual(self.input.call_count, 4)
        self.assertEqual(load_catalog(self.catalog)[0]["sourceUrl"], "https://github.com/team/project")
        self.assertIn("Could not verify org/repo", output)

    def test_interrupted_prompts_save_each_answer_and_resume_only_unknown_names(self):
        self.dataset("tags/one.lance")
        self.dataset("tags/two.lance")
        self.answers = ["https://example.com/source", EOFError()]
        result, output = self.run_cli()
        self.assertEqual(result, 2, output)
        self.assertEqual([e["name"] for e in load_catalog(self.catalog)], ["tags/one"])
        self.answers = ["NONE"]
        self.input.reset_mock()
        self.assertEqual(self.run_cli()[0], 0)
        self.assertEqual(self.input.call_count, 1)
        self.assertIn("tags/two", self.input.call_args.args[0])

    def test_no_input_records_verified_only_and_returns_pending_status(self):
        self.dataset()
        self.dataset("tags/unknown.lance")
        result, output = self.run_cli("--no-input")
        self.assertEqual(result, 2, output)
        self.assertEqual([e["name"] for e in load_catalog(self.catalog)], ["tags/org.repo"])
        self.input.assert_not_called()
        self.assertIn("Source still needed: tags/unknown", output)

    def test_prune_after_uploads_deletes_dataset_roots_only_with_snapshot_guard(self):
        self.dataset()
        self.api.list_repo_files.return_value = [
            "tags/org.repo.lance/data/current.lance", "tags/gone.lance/data/old.lance",
            "tags/gone.lance/_versions/1.manifest", "nl/old.csv", "README.md",
            ".gitattributes", ".image-history/private.lance/data/part.lance", "dataset-sources.json",
        ]
        result, output = self.run_cli("--prune")
        self.assertEqual(result, 0, output)
        self.assertEqual([e[0] for e in self.events], ["upload", "prune", "verify"])
        kwargs = self.prune_commits.call_args.kwargs
        self.assertEqual(kwargs["parent_commit"], "snapshot-sha")
        self.assertEqual({(op.path_in_repo, op.is_folder) for op in kwargs["operations"]},
                         {("tags/gone.lance", True), ("nl/old.csv", False)})
        self.assertEqual(self.api.list_repo_files.call_count, 2)
        self.api.list_repo_files.assert_called_with(
            repo_id="owner/collection", repo_type="dataset", revision="snapshot-sha")

    def test_without_prune_keeps_other_remote_datasets(self):
        self.dataset()
        self.api.list_repo_files.return_value = ["tags/gone.lance/data/old.lance"]
        self.assertEqual(self.run_cli()[0], 0)
        self.prune_commits.assert_not_called()
        self.api.list_repo_files.assert_called_once_with(
            repo_id="owner/collection", repo_type="dataset", revision="snapshot-sha")

    def test_upload_failure_skips_pruning_prompts_and_catalog_edits(self):
        self.dataset()
        self.lance_commits.side_effect = RuntimeError("upload failed")
        result, output = self.run_cli("--prune")
        self.assertEqual(result, 1, output)
        self.assertFalse(self.catalog.exists())
        self.input.assert_not_called()
        self.prune_commits.assert_not_called()
        self.assertFalse(any(event[0] == "verify" for event in self.events))

    def test_dry_run_previews_without_remote_or_local_mutations(self):
        self.dataset()
        self.api.list_repo_files.return_value = ["old.lance/data/x.lance"]
        result, output = self.run_cli("--dry-run", "--prune")
        self.assertEqual(result, 0, output)
        self.assertIn("Prune old.lance", output)
        self.assertIn("New source to check: tags/org.repo", output)
        self.assertFalse(self.catalog.exists())
        self.assertEqual(self.events, [])
        self.assertFalse((self.local / "tags/org.repo.lance" / DESCRIPTOR).exists())
        self.lance_commits.assert_not_called()
        self.prune_commits.assert_not_called()
        self.input.assert_not_called()

    def test_dry_run_marks_new_remote_paths_independently_of_source_catalog(self):
        self.dataset("tags/org.new.lance")
        self.dataset("tags/org.existing.lance")
        self.dataset("nl/org.existing.csv")
        self.write_catalog([{"name": "tags/org.new", "sourceUrl": None}])
        self.api.list_repo_files.return_value = [
            "tags/org.existing.lance/data/part.lance", "tags/org.existing.lance/_versions/1.manifest",
            "nl/org.existing.csv", "old.lance/data/part.lance", "README.md",
        ]
        before = self.catalog.read_bytes()
        for prune in (False, True):
            with self.subTest(prune=prune):
                self.api.list_repo_files.reset_mock()
                options = ["--dry-run", "--prune"] if prune else ["--dry-run"]
                result, output = self.run_cli(*options)
                self.assertEqual(result, 0, output)
                self.assertIn("Upload [NEW] tags/org.new.lance", output)
                self.assertIn("Upload [EXISTING] tags/org.existing.lance", output)
                self.assertIn("Upload [EXISTING] nl/org.existing.csv", output)
                self.assertIn("New datasets: 1; already on HF: 2", output)
                self.assertEqual("Prune old.lance" in output, prune)
                self.api.list_repo_files.assert_called_once_with(
                    repo_id="owner/collection", repo_type="dataset", revision="snapshot-sha")
        self.assertEqual(self.catalog.read_bytes(), before)
        self.assertEqual(self.events, [])
        self.lance_commits.assert_not_called()
        self.api.upload_file.assert_not_called()
        self.prune_commits.assert_not_called()
        self.input.assert_not_called()

    def test_scans_supported_files_excludes_hidden_and_keeps_lance_internal_files(self):
        self.dataset("tags/org.csv.csv")
        self.dataset("tags/org.lance.lance")
        self.dataset(".image-history/private.lance")
        self.dataset(".cache/org.hidden.parquet")
        self.dataset("README.md")
        self.catalog = self.local / "dataset-sources.json"
        self.write_catalog([])
        result, output = self.run_cli()
        self.assertEqual(result, 0, output)
        self.assertEqual(self.lance_commits.call_count, 1)
        self.api.upload_file.assert_called_once()
        self.assertEqual(self.api.upload_file.call_args.kwargs["path_in_repo"], "tags/org.csv.csv")
        self.assertEqual(len(load_catalog(self.catalog)), 2)

    def test_empty_missing_invalid_catalog_duplicate_names_and_symlinks_fail_before_api(self):
        for case in ("empty", "missing", "catalog", "alias-list", "duplicate", "symlink", "empty-lance"):
            with self.subTest(case=case):
                self.api_class.reset_mock()
                if case == "missing":
                    self.local = self.work / "missing"
                else:
                    self.local = self.work / case
                    self.local.mkdir(exist_ok=True)
                self.catalog.unlink(missing_ok=True)
                if case == "catalog":
                    self.catalog.write_text('{"not": "an array"}')
                elif case == "alias-list":
                    self.write_catalog([{"name": "tags/org.repo", "alias": ["tags/old"]}])
                    self.dataset()
                elif case == "duplicate":
                    self.dataset("tags/org.repo.csv")
                    self.dataset("tags/org.repo.jsonl")
                elif case == "symlink":
                    (self.local / "linked.lance").symlink_to(self.work, target_is_directory=True)
                elif case == "empty-lance":
                    (self.local / "empty.lance").mkdir()
                result, output = self.run_cli("--prune")
                self.assertEqual(result, 1, output)
                self.api_class.assert_not_called()

    def test_prune_conflict_does_not_retry_unconditionally(self):
        self.dataset()
        self.api.list_repo_files.return_value = ["gone.lance/data/one.lance"]
        self.prune_commits.side_effect = RuntimeError("parent commit changed")
        result, output = self.run_cli("--prune")
        self.assertEqual(result, 1, output)
        self.prune_commits.assert_called_once()
        self.assertEqual(self.prune_commits.call_args.kwargs["parent_commit"], "snapshot-sha")

    def test_catalog_root_names_and_ambiguous_leaves(self):
        entries = [{"name": "org.root", "sourceUrl": None}, {"name": "a/org.repo"}, {"name": "b/org.repo"}]
        lookup = catalog_lookup(entries)
        self.assertIs(lookup["org.root"], entries[0])
        self.assertNotIn("org.repo", lookup)
        self.assertIs(lookup["a/org.repo"], entries[1])

    def test_remote_scanner_treats_nested_lance_files_as_one_dataset(self):
        self.assertEqual(remote_datasets([
            "tags/org.repo.lance/data/part.lance", "tags/org.repo.lance/_indices/index.json",
            "tags/org.repo.lance/_versions/1.manifest", "notes.md",
        ]), {"tags/org.repo.lance"})


if __name__ == "__main__":
    unittest.main()
