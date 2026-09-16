import io
import json
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from quarry_tools.cli import main
from quarry_tools.hf_sync import catalog_lookup, load_catalog, remote_datasets


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
        self.api.upload_folder.side_effect = lambda **kw: self.events.append(("upload", kw["path_in_repo"]))
        self.api.upload_file.side_effect = lambda **kw: self.events.append(("upload", kw["path_in_repo"]))
        self.api.create_commit.side_effect = lambda **kw: self.events.append(("prune", kw))
        self.api.list_repo_files.return_value = []
        self.source_error = None
        self.answers = []
        input_patch = patch("builtins.input", side_effect=self.answer)
        self.input = input_patch.start()
        self.addCleanup(input_patch.stop)

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

    def run_cli(self, *options):
        output = io.StringIO()
        with redirect_stderr(output), redirect_stdout(output):
            result = main(["hf", "sync", str(self.local), "--repo=owner/collection",
                           "--catalog", str(self.catalog), *options])
        return result, output.getvalue()

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
        self.api.upload_folder.assert_called_with(
            folder_path=str(self.local / "tags/org.repo.two.lance"),
            path_in_repo="tags/org.repo.two.lance", repo_id="owner/collection", repo_type="dataset",
            revision="main", commit_message="Sync tags/org.repo.two")

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
        kwargs = self.api.create_commit.call_args.kwargs
        self.assertEqual(kwargs["parent_commit"], "snapshot-sha")
        self.assertEqual({(op.path_in_repo, op.is_folder) for op in kwargs["operations"]},
                         {("tags/gone.lance", True), ("nl/old.csv", False)})
        self.api.list_repo_files.assert_called_once_with(
            repo_id="owner/collection", repo_type="dataset", revision="snapshot-sha")

    def test_without_prune_no_remote_deletions(self):
        self.dataset()
        self.api.list_repo_files.return_value = ["tags/gone.lance/data/old.lance"]
        self.assertEqual(self.run_cli()[0], 0)
        self.api.create_commit.assert_not_called()
        self.api.list_repo_files.assert_not_called()

    def test_upload_failure_skips_pruning_prompts_and_catalog_edits(self):
        self.dataset()
        self.api.upload_folder.side_effect = RuntimeError("upload failed")
        result, output = self.run_cli("--prune")
        self.assertEqual(result, 1, output)
        self.assertFalse(self.catalog.exists())
        self.input.assert_not_called()
        self.api.create_commit.assert_not_called()
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
        self.api.upload_folder.assert_not_called()
        self.api.create_commit.assert_not_called()
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
        self.assertEqual(self.api.upload_folder.call_count, 1)
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
        self.api.create_commit.side_effect = RuntimeError("parent commit changed")
        result, output = self.run_cli("--prune")
        self.assertEqual(result, 1, output)
        self.api.create_commit.assert_called_once()
        self.assertEqual(self.api.create_commit.call_args.kwargs["parent_commit"], "snapshot-sha")

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
