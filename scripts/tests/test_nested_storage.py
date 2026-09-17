"""Real native-record storage, derived-search integrity, and lifecycle tests."""
import io
import json
from pathlib import Path
import shutil
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from unittest.mock import MagicMock, patch

import duckdb
import lance
import pyarrow as pa

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from quarry_tools import storage
from quarry_tools.cli import main
from quarry_tools.common import FileError
from quarry_tools.optimize import optimize_dataset, _SKIPPED


class NestedStorageTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)

    def prep(self, rows, name='records'):
        source = self.root / (name + '.jsonl')
        source.write_text('\n'.join(json.dumps(row, ensure_ascii=False) for row in rows))
        output = source.with_suffix('.lance')
        with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
            status = main(['prep', str(source), '--columns', ';'.join(rows[0])])
        self.assertEqual(status, 0)
        return output

    def rows(self):
        return [{'prompt': [{'hair': 'Blond', 'eyes': 'BLUE'}, {'hair': 'Red', 'eyes': 'Green'}], 'style': 'Photo'},
                {'prompt': [None, {'hair': 'ÉTÉ\x1fXYZ', 'eyes': None}], 'style': 'Painting'}]

    def test_native_records_helpers_coverage_and_original_output(self):
        rows = self.rows()
        path = self.prep(rows)
        ds = lance.dataset(path)
        layout = storage.read_layout(path, ds.schema)
        self.assertEqual(layout['version'], 2)
        self.assertTrue(layout['snapshot_trusted'])
        self.assertTrue(layout['helpers_indexed'])
        self.assertFalse(ds.has_stable_row_ids)
        self.assertEqual(ds.data_storage_version, '2.2')
        self.assertEqual(storage.logical_reader(ds, path).read_all().to_pylist(), rows)
        self.assertEqual(ds.to_table(columns=['__quarry_search_0']).column(0).to_pylist(), ['blond\x1fred', 'été\x1fxyz'])
        storage.verify_helpers(path)
        storage.verify_index_coverage(ds, ['style', '__quarry_search_0', '__quarry_search_1'])
        self.assertIs(optimize_dataset(path, emit=lambda _: None), _SKIPPED)

    def test_helper_fields_preserve_null_empty_boundaries_and_source_columns(self):
        table = pa.table({
            'prompt': [None, [], [None],
                       [{'hair': '', 'eyes': 'BLUE'}, None,
                        {'hair': 'ÉTÉ\x1fXYZ', 'eyes': None}, {'hair': '', 'eyes': ''}]],
            'setting': [None, {'name': ''}, {'name': 'INDOOR'}, {'name': 'Bedroom'}],
        })
        encoded, pairs = storage.encoded_reader(table.to_reader())
        path = self.root / 'helper-fields.lance'
        ds = lance.write_dataset(encoded, path, data_storage_version='2.2')
        storage.write_descriptor(path, pairs)
        helpers = ds.to_table(columns=[h['physical'] for h in pairs.helpers]).to_pydict()
        self.assertEqual(helpers, {
            '__quarry_search_0': ['', '', '', '\x1fété\x1fxyz\x1f'],
            '__quarry_search_1': ['', '', '', 'blue\x1f'],
            '__quarry_search_2': ['', '', 'indoor', 'bedroom'],
        })
        self.assertEqual(ds.to_table(columns=table.schema.names).to_pylist(), table.to_pylist())
        storage.verify_helpers(path)
        ds.update({'__quarry_search_1': "'wrong'"})
        with self.assertRaisesRegex(FileError, '__quarry_search_1.*does not match'):
            storage.verify_helpers(path)

    def test_copy_move_valid_but_mutation_of_flat_casing_fails_closed(self):
        path = self.prep(self.rows())
        copied = self.root / 'copied.lance'
        shutil.copytree(path, copied)
        moved = self.root / 'moved.lance'
        copied.rename(moved)
        self.assertTrue(storage.read_layout(moved)['snapshot_trusted'])
        lance.dataset(moved).update({'style': "'green'"})
        with self.assertRaisesRegex(FileError, 'changed outside Quarry'):
            storage.logical_reader(lance.dataset(moved), moved)

    def test_original_only_stale_helpers_are_hidden_then_optimize_regenerates(self):
        path = self.prep([{'prompt': [{'hair': 'Blond'}]}])
        ds = lance.dataset(path)
        ds.update({'__quarry_search_0': "'stale'"})
        ds.create_scalar_index('__quarry_search_0', 'NGRAM', replace=True)
        self.assertFalse(storage.read_layout(path)['snapshot_trusted'])
        self.assertEqual(storage.logical_reader(lance.dataset(path), path).read_all().to_pylist(), [{'prompt': [{'hair': 'Blond'}]}])
        optimize_dataset(path, emit=lambda _: None)
        self.assertTrue(storage.read_layout(path)['snapshot_trusted'])
        storage.verify_helpers(path)
        self.assertEqual(lance.dataset(path).to_table(columns=['__quarry_search_0']).column(0).to_pylist(), ['blond'])

    def test_incomplete_index_coverage_cannot_be_certified(self):
        path = self.prep([{'prompt': [{'hair': 'Blond'}]}])
        ds = lance.dataset(path)
        ds.update({'__quarry_search_0': "'red'"})
        from datetime import timedelta
        ds.cleanup_old_versions(older_than=timedelta(0), delete_unverified=True)
        with self.assertRaisesRegex(FileError, 'complete NGRAM'):
            storage.write_descriptor(path, {}, finalize=True)

    def test_public_reindex_cannot_bless_stale_helpers(self):
        path = self.prep([{'prompt': [{'hair': 'Blond'}]}])
        ds = lance.dataset(path)
        ds.update({'__quarry_search_0': "'stale'"})
        before = lance.dataset(path).version
        error = io.StringIO()
        with redirect_stdout(io.StringIO()), redirect_stderr(error):
            self.assertEqual(main(['lance', 'prep', str(path), '--no-clean']), 1)
        self.assertIn('not trusted', error.getvalue())
        self.assertEqual(lance.dataset(path).version, before)

    def test_public_reindex_failure_or_cancellation_preserves_published_snapshot(self):
        from quarry_tools.lance import _build_one
        for failure in (RuntimeError('index interrupted'), KeyboardInterrupt()):
            with self.subTest(failure=type(failure).__name__):
                path = self.prep(self.rows(), name=type(failure).__name__)
                before = storage.read_layout(path)
                version = lance.dataset(path).version
                create_index = lance.LanceDataset.create_scalar_index
                calls = []

                def interrupted(ds, *args, **kwargs):
                    calls.append(args)
                    if len(calls) == 2:
                        raise failure
                    return create_index(ds, *args, **kwargs)

                with patch.object(lance.LanceDataset, 'create_scalar_index', interrupted):
                    with self.assertRaises(type(failure)):
                        _build_one(path, None, [], [], False, False, False, lambda _: None, clean=False)
                self.assertEqual(len(calls), 2)
                self.assertEqual(lance.dataset(path).version, version)
                self.assertEqual(storage.read_layout(path), before)
                self.assertEqual(storage.logical_reader(lance.dataset(path), path).read_all().to_pylist(), self.rows())
                self.assertFalse(list(self.root.glob('.quarry-reindex-*')))

    def test_public_reindex_success_preserves_values_and_finalizes_snapshot(self):
        path = self.prep(self.rows())
        before = storage.read_layout(path)['snapshot']
        with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
            self.assertEqual(main(['lance', 'prep', str(path), '--no-clean']), 0)
        layout = storage.read_layout(path)
        self.assertTrue(layout['snapshot_trusted'])
        self.assertNotEqual(layout['snapshot'], before)
        self.assertEqual(storage.logical_reader(lance.dataset(path), path).read_all().to_pylist(), self.rows())
        storage.verify_helpers(path)
        storage.verify_index_coverage(lance.dataset(path), ['style', '__quarry_search_0', '__quarry_search_1'])
        self.assertIs(optimize_dataset(path, emit=lambda _: None), _SKIPPED)
        self.assertFalse(list(self.root.glob('.quarry-reindex-*')))

    def test_public_reindex_publication_failure_restores_original(self):
        import os
        from quarry_tools.lance import _build_one
        path = self.prep(self.rows())
        before = storage.read_layout(path)
        replace = os.replace

        def fail_publication(source, target):
            if Path(source).name == 'dataset.lance' and Path(target) == path:
                raise OSError('publication failed')
            return replace(source, target)

        with patch('quarry_tools.lance.os.replace', fail_publication):
            with self.assertRaisesRegex(OSError, 'publication failed'):
                _build_one(path, None, [], [], False, False, False, lambda _: None, clean=False)
        self.assertEqual(storage.read_layout(path), before)
        self.assertEqual(storage.logical_reader(lance.dataset(path), path).read_all().to_pylist(), self.rows())
        self.assertFalse(list(self.root.glob('.quarry-reindex-*')))

    def test_helper_name_collision_fails_before_output(self):
        source = self.root / 'collision.jsonl'
        source.write_text(json.dumps({'prompt': [{'hair': 'Blond'}], '__quarry_search_0': 'user data'}))
        error = io.StringIO()
        with redirect_stdout(io.StringIO()), redirect_stderr(error):
            status = main(['prep', str(source), '--columns', 'prompt;__quarry_search_0'])
        self.assertEqual(status, 1)
        self.assertIn('conflicts', error.getvalue())
        self.assertFalse(source.with_suffix('.lance').exists())

    def test_resume_index_failure_verifies_saved_values_and_helpers(self):
        source = self.root / 'resume.jsonl'
        source.write_text(json.dumps(self.rows()[0]))
        with patch('quarry_tools.lance._build_one', side_effect=RuntimeError('index interrupted')):
            with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
                self.assertEqual(main(['prep', str(source), '--columns', 'prompt;style']), 1)
        checkpoint = next(self.root.glob('.quarry-prep-*'))
        saved = json.loads((checkpoint / 'prep.json').read_text())
        self.assertEqual(saved['version'], 3)
        with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
            self.assertEqual(main(['prep', '--resume', str(checkpoint)]), 0)
        self.assertTrue(storage.read_layout(source.with_suffix('.lance'))['snapshot_trusted'])

    def test_resume_rejects_changed_derived_data_even_when_index_rebuilt(self):
        source = self.root / 'corrupt.jsonl'
        source.write_text(json.dumps(self.rows()[0]))
        with patch('quarry_tools.lance._build_one', side_effect=RuntimeError('index interrupted')):
            with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
                main(['prep', str(source), '--columns', 'prompt;style'])
        checkpoint = next(self.root.glob('.quarry-prep-*'))
        staged = checkpoint / 'dataset.lance'
        ds = lance.dataset(staged)
        ds.update({'__quarry_search_0': "'stale'"})
        ds.create_scalar_index('__quarry_search_0', 'NGRAM', replace=True)
        error = io.StringIO()
        with redirect_stdout(io.StringIO()), redirect_stderr(error):
            self.assertEqual(main(['prep', '--resume', str(checkpoint)]), 1)
        self.assertIn('does not match', error.getvalue())
        self.assertFalse(source.with_suffix('.lance').exists())

    def test_duckdb_reader_failure_prevents_publication(self):
        source = self.root / 'unreadable.jsonl'
        source.write_text(json.dumps(self.rows()[0]))
        with patch.object(storage, 'verify_duckdb', side_effect=FileError('DuckDB decode failed')):
            with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
                self.assertEqual(main(['prep', str(source), '--columns', 'prompt;style']), 1)
        self.assertFalse(source.with_suffix('.lance').exists())

    def test_duckdb_verification_installs_only_a_missing_lance_extension(self):
        cases = [
            (None, ['LOAD lance']),
            (duckdb.IOException('Extension not found. Install it first using "INSTALL lance".'),
             ['LOAD lance', 'INSTALL lance', 'LOAD lance']),
            (duckdb.IOException('Extension signature is invalid'), ['LOAD lance']),
        ]
        for error, expected_calls in cases:
            with self.subTest(error=error):
                con = MagicMock()
                con.fetch_record_batch.return_value = []
                calls = []

                def execute(sql):
                    calls.append(sql)
                    if len(calls) == 1 and error is not None:
                        raise error
                    return con

                con.execute.side_effect = execute
                expected = storage.LogicalDigest(pa.schema([('prompt', pa.string())]))
                with patch('duckdb.connect', return_value=con):
                    if error is not None and len(expected_calls) == 1:
                        with self.assertRaisesRegex(FileError, 'signature is invalid'):
                            storage.verify_duckdb(self.root, expected)
                    else:
                        storage.verify_duckdb(self.root, expected)
                self.assertEqual([sql for sql in calls if sql.endswith('lance')], expected_calls)
                con.close.assert_called_once()


if __name__ == '__main__':
    unittest.main()
