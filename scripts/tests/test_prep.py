"""Integration coverage for the single-command dataset preparation workflow."""

import csv
import io
import json
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
                self.assertEqual(ds.schema.names, ["prompt", "tags", "score", "prompt__lc", "tags__lc"])
                self.assertEqual(ds.to_table(columns=["prompt", "score"]).to_pylist(), [
                    {"prompt": "Hello!", "score": 1}, {"prompt": "World", "score": 4},
                ])
                self.assertEqual(
                    {tuple(index["fields"]) for index in ds.list_indices()},
                    {("prompt__lc",), ("tags__lc",), ("score",)},
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
        self.assertEqual(ds.to_table(columns=["prompt", "id"]).to_pylist(), [
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

    def test_failed_prep_does_not_publish_partial_output(self):
        source = self.write_source(".csv")
        with patch("quarry_tools.lance._build_one", side_effect=RuntimeError("index failed")):
            result, _, stderr, _ = self.run_cli(["prep", str(source), "--columns", "Caption=prompt"])
        self.assertEqual(result, 1)
        self.assertIn("index failed", stderr)
        self.assertEqual(list(self.root.iterdir()), [source])

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


if __name__ == "__main__":
    unittest.main()
