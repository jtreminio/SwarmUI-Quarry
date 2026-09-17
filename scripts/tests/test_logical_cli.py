"""Lance CLI views and rewrites preserve the descriptor's logical interface."""
import io
import json
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from datetime import timedelta
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import lance
import pyarrow as pa
import pyarrow.parquet as pq

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from quarry_tools import storage
from quarry_tools.browse import _make_lance_parquet
from quarry_tools.columns import _reorder_lance, cmd_show
from quarry_tools.common import FileError


class LogicalCliTests(unittest.TestCase):
    def setUp(self):
        work = tempfile.TemporaryDirectory()
        self.addCleanup(work.cleanup)
        self.root = Path(work.name)

    def dataset(self):
        path = self.root / 'sample.lance'
        table = pa.table({
            'title': ['Original CASE', 'Other'],
            'prompt': [[{'hair': 'BLOND', 'eyes': 'Blue'}, {'hair': 'Red', 'eyes': 'Green'}], []],
            'image': [b'\xff\x00\xfe', None],
            'picture': [{'bytes': b'\x80\xff', 'path': 'a.png'}, {'bytes': b'', 'path': 'b.png'}],
            'notes__lc': ['User column', 'Keep me'],
        })
        reader, pairs = storage.encoded_reader(table.to_reader())
        ds = lance.write_dataset(reader, str(path), enable_stable_row_ids=False,
                                 data_storage_version=storage.DATA_STORAGE_VERSION)
        for name in [*pairs, *(h['physical'] for h in pairs.helpers)]:
            ds.create_scalar_index(name, 'NGRAM')
        ds.cleanup_old_versions(older_than=timedelta(0), delete_unverified=True)
        storage.write_descriptor(path, pairs, finalize=True)
        return path, table

    def test_show_hides_only_recognized_companions_and_helpers(self):
        path, table = self.dataset()
        with redirect_stdout(io.StringIO()) as output:
            self.assertEqual(cmd_show(SimpleNamespace(file=str(path), format=None)), 0)
        self.assertEqual(output.getvalue().strip(), ','.join(table.schema.names))

    def test_browse_restores_case_and_nested_values_and_sizes_non_utf8_blobs(self):
        path, table = self.dataset()
        output, blobs = _make_lance_parquet(path)
        self.addCleanup(output.unlink, missing_ok=True)
        actual = pq.read_table(output)
        self.assertEqual(blobs, ['image', 'picture'])
        self.assertEqual(actual.schema.names, table.schema.names)
        self.assertEqual(actual['title'].to_pylist(), table['title'].to_pylist())
        self.assertEqual(actual['prompt'].to_pylist(), table['prompt'].to_pylist())
        self.assertEqual(actual['notes__lc'].to_pylist(), table['notes__lc'].to_pylist())
        self.assertEqual(actual['image'].to_pylist(), [3, None])
        self.assertEqual(actual['picture'].to_pylist(), [2, 0])

    def test_reorder_refinalizes_snapshot_and_preserves_logical_values_and_indexes(self):
        path, table = self.dataset()
        descriptor_path = path / storage.DESCRIPTOR
        descriptor = json.loads(descriptor_path.read_text())
        descriptor.update(datasetHash='obsolete', userMetadata='preserve')
        descriptor_path.write_text(json.dumps(descriptor))
        before = storage.read_layout(path)
        indexes = {(i['name'], tuple(i['fields']), i['type']) for i in lance.dataset(str(path)).list_indices()}
        _, order, changed = _reorder_lance(path, ['prompt'])
        self.assertTrue(changed)
        self.assertEqual(order, ['prompt', 'title', 'image', 'picture', 'notes__lc'])
        ds = lance.dataset(str(path))
        after = storage.read_layout(path, ds.schema)
        self.assertTrue(after['snapshot_trusted'])
        self.assertNotEqual(after['snapshot'], before['snapshot'])
        self.assertEqual(after['helpers'], before['helpers'])
        self.assertEqual(after['userMetadata'], 'preserve')
        self.assertNotIn('datasetHash', after)
        self.assertEqual(storage.logical_reader(ds, path).read_all(), table.select(order))
        self.assertEqual({(i['name'], tuple(i['fields']), i['type']) for i in ds.list_indices()}, indexes)
        self.assertEqual(len(ds.versions()), 1)
        self.assertFalse(ds.has_stable_row_ids)

    def test_reorder_rejects_internal_names(self):
        path, _ = self.dataset()
        for column in ['title__case', '__quarry_search_0']:
            with self.subTest(column=column), self.assertRaisesRegex(FileError, 'column.*not found'):
                _reorder_lance(path, [column])

    def test_reorder_verification_failure_preserves_original(self):
        path, table = self.dataset()
        descriptor = (path / storage.DESCRIPTOR).read_bytes()
        with patch('quarry_tools.storage.verify_dataset', side_effect=FileError('injected mismatch')):
            with self.assertRaisesRegex(FileError, 'injected mismatch'):
                _reorder_lance(path, ['prompt'])
        self.assertEqual((path / storage.DESCRIPTOR).read_bytes(), descriptor)
        self.assertEqual(storage.logical_reader(lance.dataset(str(path)), path).read_all(), table)
        self.assertEqual(list(self.root.iterdir()), [path])

    def test_untrusted_original_value_helpers_cannot_be_certified_by_reorder(self):
        path = self.root / 'unencoded.lance'
        ds = lance.write_dataset(pa.table({'id': [1], 'prompt': [[{'hair': 'Blond'}]],
                                          '__quarry_search_0': ['blond']}), str(path),
                                 enable_stable_row_ids=False)
        helpers = [dict(column='prompt', field='hair', kind='list', physical='__quarry_search_0')]
        ds.create_scalar_index('__quarry_search_0', 'NGRAM')
        ds.cleanup_old_versions(older_than=timedelta(0), delete_unverified=True)
        storage.write_descriptor(path, {}, helpers=helpers, finalize=True)
        ds.update({'id': '2'})
        with self.assertRaisesRegex(FileError, 'quarry optimize'):
            _reorder_lance(path, ['prompt'])


if __name__ == '__main__':
    unittest.main()
