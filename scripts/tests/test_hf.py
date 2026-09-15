"""Exercise HF CLI selection and downloads without network or large files."""

import io
import sys
import tempfile
import unittest
from contextlib import redirect_stderr
from pathlib import Path
from unittest.mock import patch

from huggingface_hub import RepoFile, RepoFolder
from huggingface_hub.errors import EntryNotFoundError

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from quarry_tools.cli import main
from quarry_tools.hf import _parse_repo_url


URL = "https://huggingface.co/datasets/codeShare/chroma_prompts/tree/main/photoreal/raw"


def repo_file(path):
    return RepoFile(path=path, size=10, oid="abc")


class FolderDownloadTests(unittest.TestCase):
    def setUp(self):
        work = tempfile.TemporaryDirectory()
        self.addCleanup(work.cleanup)
        self.output = Path(work.name) / "output"
        self.entries = [
            RepoFolder(path="photoreal/raw/nested.parquet", oid="abc"),
            repo_file("photoreal/raw/one.parquet"),
            repo_file("photoreal/raw/nested.parquet/two.parquet"),
            repo_file("photoreal/raw/readme.txt"),
            repo_file("photoreal/raw/three.PARQUET"),
            repo_file("photoreal/raw/notparquet"),
        ]
        api_patch = patch("huggingface_hub.HfApi", autospec=True)
        self.api = api_patch.start()
        self.addCleanup(api_patch.stop)
        self.api.return_value.list_repo_tree.side_effect = lambda **_: iter(self.entries)
        download_patch = patch("huggingface_hub.hf_hub_download")
        self.download = download_patch.start()
        self.download.side_effect = self.fake_download
        self.addCleanup(download_patch.stop)
        token_patch = patch.dict("os.environ", {"HF_TOKEN": "test-token"})
        token_patch.start()
        self.addCleanup(token_patch.stop)

    def fake_download(self, **kwargs):
        path = Path(kwargs["local_dir"]) / kwargs["filename"]
        path.parent.mkdir(parents=True, exist_ok=True)
        if not path.exists() or kwargs["force_download"]:
            path.write_text(kwargs["filename"])
        return str(path)

    def run_cli(self, *options, url=URL):
        errors = io.StringIO()
        with redirect_stderr(errors):
            result = main(["hf", "download-folder", url, "-o", str(self.output), *options])
        return result, errors.getvalue()

    def test_filters_extensions_and_downloads_nested_files(self):
        for extension in ("parquet", ".parquet"):
            with self.subTest(extension=extension):
                self.download.reset_mock()
                result, errors = self.run_cli(f"--ext={extension}", "--force", "-w", "2")
                self.assertEqual(result, 0, errors)
                self.api.assert_called_with(endpoint=None, token="test-token")
                self.api.return_value.list_repo_tree.assert_called_with(
                    repo_id="codeShare/chroma_prompts", path_in_repo="photoreal/raw",
                    repo_type="dataset", revision="main", recursive=True,
                )
                self.assertEqual({call.kwargs["filename"] for call in self.download.call_args_list}, {
                    "photoreal/raw/one.parquet", "photoreal/raw/nested.parquet/two.parquet",
                })
                for call in self.download.call_args_list:
                    self.assertEqual(call.kwargs, dict(
                        repo_id="codeShare/chroma_prompts", filename=call.kwargs["filename"],
                        repo_type="dataset", revision="main", local_dir=call.kwargs["local_dir"],
                        token="test-token", endpoint=None, force_download=True,
                    ))
                    self.assertTrue(Path(call.kwargs["local_dir"]).is_relative_to(self.output / ".cache" / "quarry"))
                self.assertEqual((self.output / "one.parquet").read_text(), "photoreal/raw/one.parquet")
                self.assertEqual((self.output / "nested.parquet/two.parquet").read_text(), "photoreal/raw/nested.parquet/two.parquet")
                self.assertFalse((self.output / "photoreal").exists())
                self.assertEqual([p for p in (self.output / ".cache").rglob("*.parquet") if p.is_file()], [])

    def test_without_filter_downloads_all_files_but_no_directories(self):
        result, errors = self.run_cli()
        self.assertEqual(result, 0, errors)
        self.assertEqual(self.download.call_count, 5)
        self.assertEqual({c.kwargs["filename"] for c in self.download.call_args_list}, {
            entry.path for entry in self.entries if isinstance(entry, RepoFile)
        })

    def test_dry_run_and_no_matches_do_not_create_output_or_download(self):
        for options in (("--dry-run", "--ext=parquet"), ("--ext=csv",)):
            with self.subTest(options=options):
                result, errors = self.run_cli(*options)
                self.assertEqual(result, 0, errors)
                self.download.assert_not_called()
                self.assertFalse(self.output.exists())
                if "--dry-run" in options:
                    self.assertIn("photoreal/raw/one.parquet", errors)
                    self.assertIn(f" -> {self.output / 'one.parquet'}", errors)
                    self.assertNotIn("readme.txt", errors)
                else:
                    self.assertIn("No matching files", errors)

    def test_empty_folder(self):
        self.entries = []
        result, errors = self.run_cli()
        self.assertEqual(result, 0, errors)
        self.download.assert_not_called()

    def test_listing_failure_during_pagination_downloads_nothing(self):
        def broken_listing(**kwargs):
            yield self.entries[1]
            raise RuntimeError("listing failed")

        self.api.return_value.list_repo_tree.side_effect = broken_listing
        result, errors = self.run_cli()
        self.assertEqual(result, 1)
        self.assertIn("could not list folder", errors)
        self.download.assert_not_called()

    def test_transient_download_error_retries(self):
        self.entries = [repo_file("photoreal/raw/one.parquet")]

        def fail_once(**kwargs):
            if self.download.call_count == 1:
                raise RuntimeError("temporary")
            return self.fake_download(**kwargs)

        self.download.side_effect = fail_once
        with patch("quarry_tools.hf.time.sleep") as sleep:
            result, errors = self.run_cli("--retries=2")
        self.assertEqual(result, 0, errors)
        self.assertEqual(self.download.call_count, 2)
        sleep.assert_called_once_with(2)

    def test_missing_file_returns_failure_without_retry(self):
        self.entries = [repo_file("photoreal/raw/one.parquet")]
        self.download.side_effect = EntryNotFoundError("gone")
        result, errors = self.run_cli()
        self.assertEqual(result, 1)
        self.assertIn("not found in repo", errors)
        self.download.assert_called_once()

    def test_invalid_options_fail_before_listing(self):
        for option in ("--ext=", "--ext=.", "--ext=*.parquet", "--workers=0", "--retries=0"):
            with self.subTest(option=option), self.assertRaises(SystemExit):
                self.run_cli(option)
        self.api.assert_not_called()

    def test_default_output_and_root_url(self):
        self.download.side_effect = None
        with patch("quarry_tools.hf.Path.mkdir"), redirect_stderr(io.StringIO()):
            result = main(["hf", "download-folder", "https://huggingface.co/team/model/tree/v1"])
        self.assertEqual(result, 0)
        self.assertIsNone(self.api.return_value.list_repo_tree.call_args.kwargs["path_in_repo"])
        self.assertEqual(self.download.call_args.kwargs["local_dir"], "model")

    def test_authentication_label_preserves_sdk_managed_login(self):
        for env, expected_token, label in (
            ({}, None, "SDK-managed (saved login or anonymous)"),
            ({"HUGGINGFACE_HUB_TOKEN": "legacy-token"}, "legacy-token", "$HUGGINGFACE_HUB_TOKEN"),
        ):
            with self.subTest(env=env), patch.dict("os.environ", env, clear=True):
                result, errors = self.run_cli()
                self.assertEqual(result, 0, errors)
                self.assertIn(f"Token:    {label}", errors)
                self.assertEqual(self.download.call_args.kwargs["token"], expected_token)

    def test_output_expands_literal_tilde(self):
        result, errors = self.run_cli("-o=~/downloads", "--dry-run")
        self.assertEqual(result, 0, errors)
        expected = Path.home() / "downloads"
        self.download.assert_not_called()
        self.assertIn(f"Output:   {expected}", errors)

    def test_selected_folder_is_output_root_and_nested_names_do_not_collide(self):
        self.entries = [repo_file(f"data/{name}") for name in (
            "part.parquet", "validation/part.parquet", "training/part.parquet",
        )]
        result, errors = self.run_cli(url="https://huggingface.co/datasets/team/repo/tree/main/data")
        self.assertEqual(result, 0, errors)
        for entry in self.entries:
            local = self.output / entry.path.removeprefix("data/")
            self.assertEqual(local.read_text(), entry.path)
        self.assertFalse((self.output / "data").exists())

    def test_rerun_supplies_existing_files_to_sdk_and_force_refreshes(self):
        self.entries = [repo_file("photoreal/raw/one.parquet")]
        self.assertEqual(self.run_cli()[0], 0)
        destination = self.output / "one.parquet"
        destination.write_text("existing content")
        original_mtime = destination.stat().st_mtime_ns

        def check_existing(**kwargs):
            staged = Path(kwargs["local_dir"]) / kwargs["filename"]
            self.assertEqual(staged.read_text(), "existing content")
            self.assertEqual(staged.stat().st_mtime_ns, original_mtime)
            return str(staged)

        self.download.side_effect = check_existing
        self.assertEqual(self.run_cli()[0], 0)
        self.assertEqual(destination.read_text(), "existing content")
        self.download.side_effect = self.fake_download
        self.assertEqual(self.run_cli("--force")[0], 0)
        self.assertEqual(destination.read_text(), "photoreal/raw/one.parquet")

    def test_failed_update_keeps_existing_destination(self):
        self.entries = [repo_file("photoreal/raw/one.parquet")]
        self.assertEqual(self.run_cli()[0], 0)
        destination = self.output / "one.parquet"
        before = destination.read_bytes()

        def fail_after_write(**kwargs):
            staged = Path(kwargs["local_dir"]) / kwargs["filename"]
            staged.write_text("unfinished")
            raise RuntimeError("download interrupted")

        self.download.side_effect = fail_after_write
        result, errors = self.run_cli("--retries=1")
        self.assertEqual(result, 1, errors)
        self.assertEqual(destination.read_bytes(), before)

    def test_repository_root_keeps_repository_subfolders(self):
        result, errors = self.run_cli(url="https://huggingface.co/datasets/team/repo/tree/main")
        self.assertEqual(result, 0, errors)
        self.assertEqual((self.output / "photoreal/raw/one.parquet").read_text(), "photoreal/raw/one.parquet")
        self.assertEqual(self.download.call_args.kwargs["local_dir"], str(self.output))

    def test_range_still_downloads_inclusive_padded_filenames(self):
        prefix = "https://huggingface.co/datasets/team/data/resolve/main/parts/"
        with redirect_stderr(io.StringIO()):
            result = main([
                "hf", "download-range", prefix + "001.parquet", prefix + "003.parquet",
                "-o", str(self.output),
            ])
        self.assertEqual(result, 0)
        self.assertEqual({c.kwargs["filename"] for c in self.download.call_args_list}, {
            "parts/001.parquet", "parts/002.parquet", "parts/003.parquet",
        })
        self.assertEqual((self.output / "parts/001.parquet").read_text(), "parts/001.parquet")


class FolderUrlTests(unittest.TestCase):
    def test_repo_types_revisions_and_encoded_paths(self):
        for prefix, repo_type in (("datasets/", "dataset"), ("spaces/", "space"), ("", None)):
            with self.subTest(prefix=prefix):
                parsed = _parse_repo_url(
                    f"https://huggingface.co/{prefix}team/repo/tree/refs%2Fpr%2F1/a%20b/raw/?download=true",
                    "tree",
                )
                self.assertEqual(parsed.repo_id, "team/repo")
                self.assertEqual(parsed.repo_type, repo_type)
                self.assertEqual(parsed.revision, "refs/pr/1")
                self.assertEqual(parsed.path, "a b/raw")

    def test_invalid_urls(self):
        for url in (
            "not-a-url", "https://huggingface.co/team/repo/resolve/main/file",
            "https://huggingface.co/team/repo/tree/", "https://huggingface.co/repo/tree/main",
        ):
            with self.subTest(url=url), self.assertRaises(SystemExit):
                _parse_repo_url(url, "tree")


if __name__ == "__main__":
    unittest.main()
