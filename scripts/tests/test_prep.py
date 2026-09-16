"""Integration coverage for the single-command dataset preparation workflow."""

import csv
import io
import json
import os
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from decimal import Decimal
from pathlib import Path
from unittest.mock import patch

import lance
import pyarrow as pa
import pyarrow.parquet as pq

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from quarry_tools.cli import main
from quarry_tools.common import FileError
from quarry_tools.prep import plan_columns
from quarry_tools.prep_clean import cleaned_reader
from quarry_tools.lance import normalize_prompt
from quarry_tools.storage import logical_reader


class ColumnSelectionTests(unittest.TestCase):
    def test_selection_renames_orders_and_preserves_bare_names(self):
        self.assertEqual(
            plan_columns(["ID", "Caption", "tags", "extra"], "tags;caption=prompt;id"),
            [("tags", "tags"), ("Caption", "prompt"), ("ID", "ID")],
        )

    def test_selection_accepts_surrounding_quotes_and_preserves_inner_quotes(self):
        existing = ["subject_and_action", "artist's name", "mood"]
        selection = "subject_and_action=prompt;artist's name;mood"
        expected = [("subject_and_action", "prompt"), ("artist's name", "artist's name"), ("mood", "mood")]
        for quote in ("'", '"'):
            with self.subTest(quote=quote):
                self.assertEqual(plan_columns(existing, f"  {quote}{selection}{quote}  "), expected)

    def test_invalid_selections(self):
        for selection in ("", "; ;", "missing", "=prompt", "Caption=", "ID;id", "ID=x;Caption=X"):
            with self.subTest(selection=selection), self.assertRaises(FileError):
                plan_columns(["ID", "Caption"], selection)
        with self.assertRaisesRegex(FileError, "ambiguous"):
            plan_columns(["ID", "id"], "id")


class PrepTests(unittest.TestCase):
    def setUp(self):
        self.work = tempfile.TemporaryDirectory()
        self.addCleanup(self.work.cleanup)
        self.root = Path(self.work.name)
        # Index creation and cleaning are real. Avoid requiring a downloaded
        # DuckDB Lance extension merely to determine whether text is lowercase.
        def all_lowercase(path, col):
            values = lance.dataset(path).to_table(columns=[col]).column(col).to_pylist()
            return all(value is None or value == value.lower() for value in values)

        self.lowercase = patch("quarry_tools.lance._all_lowercase", side_effect=all_lowercase)
        self.lowercase.start()
        self.addCleanup(self.lowercase.stop)

    def run_cli(self, argv, responses=()):
        output, errors = io.StringIO(), io.StringIO()
        with redirect_stdout(output), redirect_stderr(errors), patch(
            "builtins.input", side_effect=responses
        ) as prompt:
            result = main(argv)
        return result, output.getvalue(), errors.getvalue(), prompt

    def write_source(self, suffix):
        path = self.root / ("input" + suffix)
        rows = [
            {"ID": 1, "Caption": "Hello!", "tags": "Art", "drop": "unused"},
            {"ID": 2, "Caption": "hello", "tags": "other", "drop": "unused"},
            {"ID": 3, "Caption": "  ", "tags": "other", "drop": "unused"},
            {"ID": 4, "Caption": "World", "tags": "Photo", "drop": "unused"},
        ]
        if suffix in (".csv", ".tsv"):
            with path.open("w", newline="") as f:
                writer = csv.DictWriter(f, fieldnames=list(rows[0]), delimiter="\t" if suffix == ".tsv" else ",")
                writer.writeheader()
                writer.writerows(rows)
        elif suffix in (".jsonl", ".ndjson"):
            path.write_text("\n".join(json.dumps(row) for row in rows))
        elif suffix == ".json":
            path.write_text(json.dumps(rows))
        elif suffix == ".parquet":
            pq.write_table(pa.Table.from_pylist(rows), path)
        else:
            lance.write_dataset(pa.Table.from_pylist(rows), str(path))
        return path

    def test_all_supported_formats_are_selected_cleaned_and_indexed(self):
        for suffix in (".csv", ".tsv", ".json", ".jsonl", ".ndjson", ".parquet", ".lance"):
            with self.subTest(suffix=suffix):
                source = self.write_source(suffix)
                before = source.read_bytes() if source.is_file() else lance.dataset(str(source)).version
                output = self.root / f"out{suffix}.lance"
                result, stdout, stderr, prompt = self.run_cli(
                    ["prep", str(source), "-o", str(output), "--batch-rows", "2"],
                    ['"caption=prompt;tags;ID=score"'],
                )
                self.assertEqual(result, 0, stderr)
                self.assertTrue(stdout.startswith("Rows: 4\nAvailable columns:\n"), stdout)
                self.assertIn("Available columns:", stdout)
                self.assertIn("Caption", stdout)
                self.assertEqual(prompt.call_count, 1)
                ds = lance.dataset(str(output))
                self.assertEqual(ds.schema.names, ["prompt", "tags", "score", "prompt__case", "tags__case"])
                self.assertEqual(logical_reader(ds, output, ["prompt", "score"]).read_all().to_pylist(), [
                    {"prompt": "Hello!", "score": 1}, {"prompt": "World", "score": 4},
                ])
                self.assertEqual(
                    {tuple(index["fields"]) for index in ds.list_indices()},
                    {("prompt",), ("tags",), ("score",)},
                )
                after = source.read_bytes() if source.is_file() else lance.dataset(str(source)).version
                self.assertEqual(before, after)

    def test_list_prompt_stays_first_and_is_cleaned_after_flattening(self):
        source = self.root / "lists.parquet"
        pq.write_table(pa.table({
            "items": [["Hello", "world"], ["hello", "WORLD"], [], None, ["Next"]],
            "id": [1, 2, 3, 4, 5],
            "tags": [["Art"], [], [], [], ["Photo"]],
        }), source)
        result, _, stderr, prompt = self.run_cli([
            "prep", str(source), "--columns", "items=prompt;id;tags", "--batch-rows", "1",
        ])
        self.assertEqual(result, 0, stderr)
        prompt.assert_not_called()
        ds = lance.dataset(str(source.with_suffix(".lance")))
        self.assertEqual(ds.schema.names[:3], ["prompt", "id", "tags"])
        self.assertEqual(logical_reader(ds, source.with_suffix(".lance"), ["prompt", "id"]).read_all().to_pylist(), [
            {"prompt": "Hello, world", "id": 1}, {"prompt": "Next", "id": 5},
        ])

    def test_decimal_columns_are_preserved_without_unsupported_indices(self):
        table = pa.table({
            "prompt": ["first", "second", "third"],
            "score": pa.array([
                Decimal("99999999999999999999999999999999999999"), Decimal("-42"), None,
            ], type=pa.decimal128(38, 0)),
            "fraction": pa.array([
                Decimal("12345678901234567890.1234"), Decimal("-0.0001"), None,
            ], type=pa.decimal128(38, 4)),
            "fav_count": [1, 2, 3],
            "weight": [1.5, 2.5, 3.5],
        })
        for command in ("prep", "lance prep"):
            with self.subTest(command=command):
                source = self.root / ("decimals.parquet" if command == "prep" else "existing.lance")
                if command == "prep":
                    pq.write_table(table, source)
                    argv = ["prep", str(source), "--columns", ";".join(table.schema.names)]
                else:
                    lance.write_dataset(table, str(source))
                    # Explicit requests must handle the same unsupported type.
                    argv = ["lance", "prep", str(source), "--btree", "score", "--bitmap", "fraction"]
                result, stdout, stderr, _ = self.run_cli(argv)
                self.assertEqual(result, 0, stderr)
                ds = lance.dataset(str(source.with_suffix(".lance")))
                self.assertEqual(ds.to_table(columns=table.schema.names), table)
                self.assertEqual(
                    {tuple(index["fields"]) for index in ds.list_indices()},
                    {("prompt",), ("fav_count",), ("weight",)},
                )
                self.assertIn("'score': BTREE index skipped", stdout)
                self.assertIn("decimal128(38, 0)", stdout)
                self.assertIn("'fraction': BTREE index skipped", stdout)
                if command == "lance prep":
                    self.assertIn("'fraction': BITMAP index skipped", stdout)

    def test_invalid_interactive_selection_reprompts(self):
        source = self.write_source(".csv")
        result, _, stderr, prompt = self.run_cli(
            ["prep", str(source)], ["missing", "", "Caption=prompt"],
        )
        self.assertEqual(result, 0, stderr)
        self.assertEqual(prompt.call_count, 3)
        self.assertIn("not found", stderr)

    def test_cancel_or_invalid_selection_leaves_no_output(self):
        source = self.write_source(".csv")
        for response in (EOFError(), KeyboardInterrupt()):
            result, _, _, _ = self.run_cli(["prep", str(source)], [response])
            self.assertEqual(result, 1)
            self.assertEqual(list(self.root.iterdir()), [source])
        result, _, _, _ = self.run_cli(["prep", str(source), "--columns", "missing"])
        self.assertEqual(result, 1)
        self.assertEqual(list(self.root.iterdir()), [source])

    def test_failed_index_preserves_checkpoint_and_resume_skips_conversion(self):
        source = self.write_source(".csv")
        with patch("quarry_tools.lance._build_one", side_effect=RuntimeError("index failed")):
            result, _, stderr, _ = self.run_cli(["prep", str(source), "--columns", "Caption=prompt"])
        self.assertEqual(result, 1)
        self.assertIn("index failed", stderr)
        checkpoints = list(self.root.glob(".quarry-prep-*"))
        self.assertEqual(len(checkpoints), 1)
        checkpoint = checkpoints[0]
        self.assertIn(f"--resume {checkpoint}", stderr)
        self.assertFalse(source.with_suffix(".lance").exists())
        self.assertEqual(lance.dataset(str(checkpoint / "dataset.lance")).count_rows(), 2)
        self.assertEqual(sorted(p.name for p in checkpoint.iterdir()), ["dataset.lance", "prep.json"])
        with patch("quarry_tools.prep.open_source", side_effect=AssertionError("must not reread source")):
            result, _, stderr, _ = self.run_cli(["prep", "--resume", str(checkpoint)])
        self.assertEqual(result, 0, stderr)
        self.assertEqual(lance.dataset(str(source.with_suffix(".lance"))).count_rows(), 2)
        self.assertFalse(checkpoint.exists())

    def test_index_spills_are_redirected_and_resume_reuses_casing_storage(self):
        source = self.write_source(".parquet")
        spill_roots = []

        def fail_index(ds, *args, **kwargs):
            scratch = Path(os.environ["TMPDIR"])
            spill_roots.append(scratch)
            self.assertTrue(scratch.is_relative_to(self.root))
            self.assertTrue(scratch.is_dir())
            (scratch / "unfinished-spill").write_text("partial")
            raise RuntimeError("index failed after companion creation")

        with patch.dict(os.environ, {"TMPDIR": str(self.root)}):
            with patch.object(lance.LanceDataset, "create_scalar_index", fail_index):
                result, _, stderr, _ = self.run_cli(["prep", str(source), "--columns", "Caption=prompt"])
            self.assertEqual(os.environ["TMPDIR"], str(self.root))
        self.assertEqual(result, 1)
        self.assertIn("index failed after companion", stderr)
        checkpoint = next(self.root.glob(".quarry-prep-*"))
        self.assertIn("prompt__case", lance.dataset(str(checkpoint / "dataset.lance")).schema.names)
        self.assertFalse(spill_roots[0].exists())
        with patch.object(lance.LanceDataset, "add_columns", side_effect=AssertionError("must reuse companion")):
            result, stdout, stderr, _ = self.run_cli(["prep", "--resume", str(checkpoint)])
        self.assertEqual(result, 0, stderr)
        self.assertIn("NGRAM in place", stdout)
        ds = lance.dataset(str(source.with_suffix(".lance")))
        self.assertEqual(ds.to_table(columns=["prompt"]).column(0).to_pylist(), ["hello!", "world"])
        self.assertEqual({tuple(index["fields"]) for index in ds.list_indices()}, {("prompt",)})

    def test_resume_rejects_existing_output_without_losing_checkpoint(self):
        source = self.write_source(".csv")
        with patch("quarry_tools.lance._build_one", side_effect=KeyboardInterrupt()):
            result, _, _, _ = self.run_cli(["prep", str(source), "--columns", "Caption=prompt"])
        self.assertEqual(result, 1)
        checkpoint = next(self.root.glob(".quarry-prep-*"))
        output = source.with_suffix(".lance")
        output.mkdir()
        (output / "keep-me").write_text("existing output")
        result, _, stderr, _ = self.run_cli(["prep", "--resume", str(checkpoint)])
        self.assertEqual(result, 1)
        self.assertIn("new .lance path", stderr)
        self.assertTrue((checkpoint / "dataset.lance").exists())
        self.assertEqual((output / "keep-me").read_text(), "existing output")

    def test_resume_failure_keeps_checkpoint(self):
        source = self.write_source(".csv")
        with patch("quarry_tools.lance._build_one", side_effect=RuntimeError("index failed")):
            self.run_cli(["prep", str(source), "--columns", "Caption=prompt"])
            checkpoint = next(self.root.glob(".quarry-prep-*"))
            result, _, stderr, _ = self.run_cli(["prep", "--resume", str(checkpoint)])
        self.assertEqual(result, 1)
        self.assertIn("--resume", stderr)
        self.assertTrue((checkpoint / "dataset.lance").exists())

    def test_lance_defaults_to_separate_prepared_dataset(self):
        source = self.write_source(".lance")
        result, _, stderr, _ = self.run_cli(["prep", str(source), "--columns", "Caption=prompt"])
        self.assertEqual(result, 0, stderr)
        self.assertTrue((self.root / "input.prepared.lance").is_dir())
        with self.assertRaisesRegex(SystemExit, "already exists"):
            self.run_cli(["prep", str(source), "-o", str(source)])

    def test_prompt_override_uses_renamed_name(self):
        source = self.write_source(".json")
        result, _, stderr, _ = self.run_cli([
            "prep", str(source), "--columns", "ID;Caption=body", "--prompt-column", "body",
        ])
        self.assertEqual(result, 0, stderr)
        self.assertEqual(lance.dataset(str(source.with_suffix(".lance"))).count_rows(), 2)

    def test_search_companion_collision_does_not_drop_selected_data(self):
        source = self.root / "collision.parquet"
        pq.write_table(pa.table({"prompt": ["Hello"], "prompt__lc": ["Keep me"]}), source)
        result, _, stderr, _ = self.run_cli(["prep", str(source), "--columns", "prompt;prompt__lc"])
        self.assertEqual(result, 1)
        self.assertIn("conflicts", stderr)
        self.assertEqual(list(self.root.iterdir()), [source])

    def test_cleanup_preserves_unicode_rules_first_rows_and_punctuation_only_rows(self):
        values = [
            "Hello!", "hello", "HéLLo", "h é l l o", "İ", "i\u0307", "I",
            "ΟΣ", "ος", "οσ", "²", "2", "猫!", "猫", "!!!", "!!!",
            None, "  ", "\t", "\u00a0", "\n", "_", "a_b", "ab", "A\x00B",
        ]
        table = pa.table({"prompt": values, "id": range(len(values)),
                          "__quarry_order": range(len(values)), "__quarry_key": values})
        seen, expected_ids = set(), []
        for i, value in enumerate(values):
            if value is None or not value.strip(" "):
                continue
            key = normalize_prompt(value)
            if key and key in seen:
                continue
            seen.add(key)
            expected_ids.append(i)
        with cleaned_reader(
            table.to_reader(max_chunksize=2), "prompt", self.root,
            batch_rows=2, memory_limit="64MB", emit=lambda _: None,
        ) as reader:
            actual = reader.read_all()
        self.assertEqual(actual, table.take(pa.array(expected_ids)))

    def test_cleanup_handles_nontext_prompt_and_preserves_arrow_types(self):
        table = pa.table({
            "score": pa.array([1, None, 1, 2], type=pa.int16()),
            "body": pa.array(["first", "null", "repeat", "last"], type=pa.large_string()),
        })
        with cleaned_reader(table.to_reader(), "score", self.root, emit=lambda _: None) as reader:
            actual = reader.read_all()
        self.assertEqual(actual, table.take(pa.array([0, 2, 3])))

    def test_all_empty_source_can_be_prepared(self):
        source = self.root / "empty.parquet"
        pq.write_table(pa.table({"prompt": [None, "", "  "]}), source)
        result, _, stderr, _ = self.run_cli(["prep", str(source), "--columns", "prompt"])
        self.assertEqual(result, 0, stderr)
        self.assertEqual(lance.dataset(str(source.with_suffix(".lance"))).count_rows(), 0)

    def test_cleanup_failure_leaves_source_and_removes_staging(self):
        source = self.write_source(".parquet")
        before = source.read_bytes()
        result, _, stderr, _ = self.run_cli([
            "prep", str(source), "--columns", "Caption=prompt", "--memory-limit", "not-a-size",
        ])
        self.assertEqual(result, 1)
        self.assertIn("error:", stderr)
        self.assertEqual(source.read_bytes(), before)
        self.assertEqual(list(self.root.iterdir()), [source])


if __name__ == "__main__":
    unittest.main()
