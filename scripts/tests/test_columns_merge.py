"""Exercise object wildcard merges against real DuckDB file readers/writers."""

import csv
import io
import json
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path

import duckdb
import pyarrow as pa
import pyarrow.parquet as pq

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from quarry_tools.cli import main


class ObjectWildcardMergeTests(unittest.TestCase):
    def setUp(self):
        self.work = tempfile.TemporaryDirectory()
        self.addCleanup(self.work.cleanup)
        self.root = Path(self.work.name)

    def run_cli(self, args):
        output, errors = io.StringIO(), io.StringIO()
        with redirect_stdout(output), redirect_stderr(errors):
            result = main(["columns", "merge", *args])
        return result, output.getvalue(), errors.getvalue()

    def test_all_object_values_across_supported_formats(self):
        subjects = [
            {"subject": "a woman", "hair": "brown", "empty": "", "missing": None, "score": 4},
            {"subject": "a man", "hair": "black", "empty": "", "missing": None, "score": 0},
        ]
        for fmt in ("parquet", "csv", "jsonl"):
            with self.subTest(fmt=fmt):
                source = self.root / f"data.{fmt}"
                rows = [
                    {"id": 1, "subject": subjects, "style": "photo"},
                    {"id": 2, "subject": [], "style": "sketch"},
                    {"id": 3, "subject": None, "style": "painting"},
                ]
                if fmt == "parquet":
                    pq.write_table(pa.Table.from_pylist(rows), source)
                elif fmt == "csv":
                    with source.open("w", newline="") as f:
                        writer = csv.DictWriter(f, fieldnames=["id", "subject", "style"])
                        writer.writeheader()
                        writer.writerows({**row, "subject": json.dumps(row["subject"])} for row in rows)
                else:
                    source.write_text("\n".join(json.dumps(row) for row in rows))
                result, _, errors = self.run_cli([
                    str(source), "subject[].*", "--name", "subject", "--delimiter", " | ",
                ])
                self.assertEqual(result, 0, errors)
                with duckdb.connect() as con:
                    table = con.read_parquet(str(source)) if fmt == "parquet" else (
                        con.read_csv(str(source)) if fmt == "csv" else con.read_json(str(source))
                    )
                    self.assertEqual(table.columns, ["id", "subject", "style"])
                    self.assertEqual(table.fetchall(), [
                        (1, "a woman | brown | 4 | a man | black | 0", "photo"),
                        (2, None, "sketch"),
                        (3, None, "painting"),
                    ])

    def test_object_wildcard_preserves_nested_json_and_supports_further_paths(self):
        source = self.root / "data.csv"
        subject = [{"first": {"description": "warm"}, "second": {"description": "soft"}}]
        with source.open("w", newline="") as f:
            writer = csv.DictWriter(f, fieldnames=["subject"])
            writer.writeheader()
            writer.writerow({"subject": json.dumps(subject)})
        result, _, errors = self.run_cli([str(source), "subject[].*", "--name", "raw", "--keep"])
        self.assertEqual(result, 0, errors)
        result, _, errors = self.run_cli([
            str(source), "subject[].*.description", "--keep", "--use-column-names",
        ])
        self.assertEqual(result, 0, errors)
        with duckdb.connect() as con:
            row = con.read_csv(str(source)).project('raw, prompt').fetchone()
        self.assertEqual(row, ('{"description":"warm"}, {"description":"soft"}', 'subject description: warm, soft'))

    def test_object_wildcard_labels_and_array_path_variants(self):
        for path in ("subject[0].*", "subject.0.*", "subject[*].*", "meta.*", "subject[].expression"):
            with self.subTest(path=path):
                source = self.root / "data.jsonl"
                source.write_text(json.dumps({
                    "subject": [{"expression": "smiling", "hair": "brown"}],
                    "meta": {"style": "photo", "lighting": "warm"},
                }))
                result, _, errors = self.run_cli([str(source), path, "--use-column-names", "--keep"])
                self.assertEqual(result, 0, errors)
                row = json.loads(source.read_text())
                expected = {
                    "subject[0].*": "subject 0: smiling, brown",
                    "subject.0.*": "subject 0: smiling, brown",
                    "subject[*].*": "subject: smiling, brown",
                    "meta.*": "meta: photo, warm",
                    "subject[].expression": "subject expression: smiling",
                }[path]
                self.assertEqual(row["prompt"], expected)
                self.assertIn("subject", row)
                self.assertIn("meta", row)

    def test_unmatched_wildcard_path_leaves_source_unchanged(self):
        source = self.root / "data.jsonl"
        original = json.dumps({"subject": [{"expression": "smiling"}]})
        source.write_text(original)
        result, _, errors = self.run_cli([str(source), "subject[].missing.*"])
        self.assertEqual(result, 1)
        self.assertIn("matched no values", errors)
        self.assertEqual(source.read_text(), original)


if __name__ == "__main__":
    unittest.main()
