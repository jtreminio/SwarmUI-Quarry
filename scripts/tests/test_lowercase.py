"""Real Lance coverage for replacing prepared lowercase companions."""

import io
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest.mock import patch

import lance
import pyarrow as pa

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from quarry_tools.cli import main


class LowercaseTests(unittest.TestCase):
    def setUp(self):
        self.work = tempfile.TemporaryDirectory()
        self.addCleanup(self.work.cleanup)
        self.root = Path(self.work.name)

    def dataset(self, path=None):
        path = path or self.root / "test.lance"
        table = pa.table({
            "prompt": ["Blue Hair", "RED Hair", None],
            "id": [1, 2, 3],
            "tag with spaces": ["PHOTO", "Art", ""],
            "prompt__lc": ["blue hair", "red hair", None],
            "tag with spaces__lc": ["photo", "art", ""],
            "orphan__lc": ["Keep This", None, ""],
        }).replace_schema_metadata({b"owner": b"test"})
        ds = lance.write_dataset(table, str(path), max_rows_per_file=2, max_rows_per_group=2)
        ds.create_scalar_index("prompt__lc", "NGRAM")
        ds.create_scalar_index("tag with spaces__lc", "NGRAM")
        ds.create_scalar_index("id", "BTREE")
        return path, ds

    def run_cli(self, path):
        output, errors = io.StringIO(), io.StringIO()
        with redirect_stdout(output), redirect_stderr(errors):
            code = main(["lance", "lowercase", str(path)])
        return code, output.getvalue(), errors.getvalue()

    def test_replaces_values_preserves_order_indexes_and_removes_history_and_old_files(self):
        path, before = self.dataset()
        old_files = list((path / "data").iterdir())
        self.assertEqual(self.run_cli(path)[0], 0)
        ds = lance.dataset(str(path))
        self.assertEqual(ds.to_table().to_pydict(), {
            "prompt": ["blue hair", "red hair", None],
            "id": [1, 2, 3],
            "tag with spaces": ["photo", "art", ""],
            "orphan__lc": ["Keep This", None, ""],
        })
        self.assertEqual(ds.schema.metadata, before.schema.metadata)
        self.assertEqual(len(ds.versions()), 1)
        self.assertTrue(all(not file.exists() for file in old_files))
        self.assertEqual(
            {(i["type"], tuple(ds.lance_schema.field(f).name() for f in i["fields"]))
             for i in ds.list_indices()},
            {("NGram", ("prompt",)), ("NGram", ("tag with spaces",)), ("BTree", ("id",))},
        )
        scanner = ds.scanner(filter="contains(prompt, 'blue')")
        self.assertEqual(scanner.to_table()["id"].to_pylist(), [1])
        self.assertIn("ScalarIndexQuery", scanner.explain_plan())
        version = ds.version
        self.assertEqual(self.run_cli(path)[0], 0)
        self.assertEqual(lance.dataset(str(path)).version, version)

    def test_parent_does_not_recurse_and_direct_dataset_does_not_visit_children(self):
        path, _ = self.dataset()
        nested, nested_ds = self.dataset(self.root / "nested" / "deeper.lance")
        child, child_ds = self.dataset(path / "child.lance")
        self.assertEqual(self.run_cli(path)[0], 0)
        self.assertEqual(lance.dataset(str(child)).version, child_ds.version)
        self.assertEqual(self.run_cli(self.root)[0], 0)
        self.assertEqual(lance.dataset(str(nested)).version, nested_ds.version)

    def test_directory_with_only_nested_datasets_is_an_error(self):
        self.dataset(self.root / "nested" / "deeper.lance")
        with self.assertRaisesRegex(SystemExit, "no immediate child"):
            self.run_cli(self.root)
        with self.assertRaisesRegex(SystemExit, "not a directory"):
            self.run_cli(self.root / "missing")

    def test_unpaired_columns_are_unchanged(self):
        path = self.root / "plain.lance"
        ds = lance.write_dataset(pa.table({"prompt": ["Keep CAPS"], "other__lc": ["keep"]}), str(path))
        self.assertEqual(self.run_cli(path)[0], 0)
        self.assertEqual(lance.dataset(str(path)).version, ds.version)

    def test_failed_index_build_restores_original_dataset(self):
        path, ds = self.dataset()
        expected = ds.to_table()
        with patch.object(lance.LanceDataset, "create_scalar_index", side_effect=RuntimeError("index failed")):
            code, _, errors = self.run_cli(path)
        self.assertEqual(code, 1)
        self.assertIn("index failed", errors)
        restored = lance.dataset(str(path))
        self.assertTrue(restored.to_table().equals(expected))
        self.assertEqual(restored.list_indices(), ds.list_indices())

    def test_empty_dataset_can_be_replaced(self):
        path = self.root / "empty.lance"
        lance.write_dataset(pa.table({"prompt": pa.array([], type=pa.string()),
                                      "prompt__lc": pa.array([], type=pa.string())}), str(path))
        self.assertEqual(self.run_cli(path)[0], 0)
        ds = lance.dataset(str(path))
        self.assertEqual(ds.schema.names, ["prompt"])
        self.assertEqual(ds.count_rows(), 0)

    def test_invalid_pairs_fail_before_mutation_and_batch_continues(self):
        invalid = self.root / "a-invalid.lance"
        ds = lance.write_dataset(pa.table({"x": ["X"], "x__lc": ["x"], "x__lc__lc": ["x"]}), str(invalid))
        valid, _ = self.dataset(self.root / "b-valid.lance")
        code, _, errors = self.run_cli(self.root)
        self.assertEqual(code, 1)
        self.assertIn("overlapping", errors)
        self.assertEqual(lance.dataset(str(invalid)).version, ds.version)
        self.assertNotIn("prompt__lc", lance.dataset(str(valid)).schema.names)


if __name__ == "__main__":
    unittest.main()
