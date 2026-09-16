"""Real dataset migrations plus the cross-language codec contract."""
import io
import json
import sys
import tempfile
import unittest
import zipfile
from contextlib import redirect_stdout, redirect_stderr
from datetime import timedelta
from pathlib import Path
from unittest.mock import patch

import lance
import pyarrow as pa
import pyarrow.parquet as pq

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from quarry_tools import storage
from quarry_tools.cli import main
from quarry_tools.common import FileError
from quarry_tools.optimize import optimize_dataset


class StorageTests(unittest.TestCase):
    def setUp(self):
        work = tempfile.TemporaryDirectory()
        self.addCleanup(work.cleanup)
        self.root = Path(work.name)

    def cli(self, *args):
        with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
            return main(list(args))

    def dataset(self, name="sample.lance"):
        path = self.root / name
        table = pa.table({'prompt': ['Café 🐈', 'Été', 'İstanbul', None, '', 'NASA'],
                          'tags': ['Art', 'ÉCOLE', 'City', None, '', 'SPACE'],
                          'score': [1, 2, 3, 4, 5, 6],
                          'prompt__lc': ['stale'] * 6})
        ds = lance.write_dataset(table, str(path), max_rows_per_file=2, max_rows_per_group=2)
        ds.create_scalar_index('prompt__lc', 'NGRAM')
        ds.create_scalar_index('score', 'BITMAP')
        ds.delete('score = 4')
        return path, table.filter(pa.compute.not_equal(table['score'], 4)).drop(['prompt__lc'])

    def test_shared_codec_fixtures(self):
        fixtures = Path(__file__).resolve().parents[2] / 'Tests/Fixtures/casing-v1.json'
        for row in json.loads(fixtures.read_text()):
            patch = None if row['patch'] is None else bytes.fromhex(row['patch'])
            self.assertEqual(storage.case_patch(row['original'], row['lower']), patch)
            self.assertEqual(storage.restore_case(row['lower'], patch), row['original'])

    def test_large_miniblocks_survive_optimize_reorder_and_prep(self):
        fixture = Path(__file__).resolve().parents[2] / 'Tests/Fixtures/lance-v22.zip'
        with zipfile.ZipFile(fixture) as archive:
            table = pa.table(json.loads(archive.read('expected.json')))
        path = self.root / 'large.lance'
        lance.write_dataset(table, str(path))
        optimize_dataset(path, emit=lambda _: None)
        ds = lance.dataset(str(path))
        self.assertEqual(ds.data_storage_version, '2.2')
        self.assertEqual(storage.logical_reader(ds, path).read_all(), table)
        self.assertEqual(ds.schema.field('prompt').metadata[b'lance-encoding:structural-encoding'], b'miniblock')
        self.assertEqual(self.cli('columns', 'reorder', str(path), 'tags,prompt'), 0)
        self.assertEqual(lance.dataset(str(path)).data_storage_version, '2.2')
        self.assertEqual(storage.logical_reader(lance.dataset(str(path)), path).read_all(), table.select(['tags', 'prompt']))
        parquet = self.root / 'large.parquet'
        pq.write_table(table, parquet)
        output = self.root / 'prepared.lance'
        self.assertEqual(self.cli('prep', str(parquet), '-o', str(output), '--columns', 'prompt;tags'), 0)
        self.assertEqual(lance.dataset(str(output)).data_storage_version, '2.2')
        self.assertEqual(storage.logical_reader(lance.dataset(str(output)), output).read_all(),
                         table.filter(pa.compute.is_valid(table['prompt'])))

    def test_bad_patches_fail_closed(self):
        for lower, patch in [('a', None), (None, b''), ('a', b'?'), ('a', b'S\x80'),
                             ('a', b'S\x02'), ('a', b'S\x00\x00'), ('é', b'S\x00'),
                             ('a', b'B\x80'), ('a', b'B'), ('a', b'F\xff')]:
            with self.subTest(patch=patch), self.assertRaises((FileError, UnicodeError)):
                storage.restore_case(lower, patch)

    def test_migration_preserves_live_logical_rows_indexes_and_one_version(self):
        path, expected = self.dataset()
        for _ in range(2):
            optimize_dataset(path, emit=lambda _: None)
            ds = lance.dataset(str(path))
            self.assertEqual(storage.logical_reader(ds, path).read_all(), expected)
            self.assertEqual(len(ds.versions()), 1)
            self.assertFalse((path / '_deletions').exists() and any((path / '_deletions').iterdir()))
            indexes = {(tuple(i['fields']), i['type']) for i in ds.list_indices()}
            self.assertTrue({(('prompt',), 'NGram'), (('tags',), 'NGram'), (('score',), 'Bitmap')} <= indexes)
            self.assertEqual(ds.schema.field('prompt').metadata[b'lance-encoding:structural-encoding'], b'miniblock')
            self.assertNotIn('prompt__lc', ds.schema.names)
        self.assertEqual(list(self.root.iterdir()), [path])

    def test_discovery_is_immediate_and_dry_run_does_not_write(self):
        path, _ = self.dataset()
        nested, _ = self.dataset('nested/other.lance')
        version = lance.dataset(str(path)).version
        self.assertEqual(self.cli('lance', 'optimize', str(self.root), '--dry-run'), 0)
        self.assertEqual(lance.dataset(str(path)).version, version)
        self.assertFalse((path / storage.DESCRIPTOR).exists())
        self.assertEqual(self.cli('lance', 'optimize', str(path)), 0)
        self.assertFalse((nested / storage.DESCRIPTOR).exists())
        self.assertEqual(self.cli('lance', 'optimize', str(self.root)), 0)
        self.assertFalse((nested / storage.DESCRIPTOR).exists())
        empty = self.root / 'empty'; empty.mkdir()
        with self.assertRaises(SystemExit):
            self.cli('lance', 'optimize', str(empty))

    def test_completed_dataset_skips_without_reading_rows_or_measuring_size(self):
        path, _ = self.dataset()
        optimize_dataset(path, emit=lambda _: None)
        descriptor = json.loads((path / storage.DESCRIPTOR).read_text())
        self.assertEqual(descriptor['optimized'], {'version': 1, 'lance_version': lance.dataset(str(path)).version})
        output = io.StringIO()
        with patch.object(storage, 'logical_reader', side_effect=AssertionError('read rows')), \
             patch('quarry_tools.lance._dir_size', side_effect=AssertionError('measured size')), \
             patch.object(lance, 'write_dataset', side_effect=AssertionError('rewrote data')), \
             redirect_stdout(output):
            self.assertEqual(main(['lance', 'optimize', str(path)]), 0)
        self.assertIn('0/1 dataset(s); 1 skipped; 0 failed', output.getvalue())
        self.assertNotIn('Size summary', output.getvalue())

    def test_older_completed_descriptor_is_adopted_without_rewrite(self):
        path, _ = self.dataset()
        with patch.object(storage, 'DATA_STORAGE_VERSION', '2.1'):
            optimize_dataset(path, emit=lambda _: None)
        ds = lance.dataset(str(path))
        self.assertEqual(ds.data_storage_version, '2.1')
        storage.write_descriptor(path, storage.read_descriptor(path))
        before = (path / storage.DESCRIPTOR).read_bytes()
        with patch.object(lance, 'write_dataset', side_effect=AssertionError('rewrote data')):
            self.assertEqual(self.cli('lance', 'optimize', str(path), '--dry-run'), 0)
            self.assertEqual((path / storage.DESCRIPTOR).read_bytes(), before)
            self.assertEqual(self.cli('lance', 'optimize', str(path)), 0)
        self.assertEqual(json.loads((path / storage.DESCRIPTOR).read_text())['optimized']['lance_version'], ds.version)
        self.assertEqual(lance.dataset(str(path)).version, ds.version)

    def test_changed_lance_or_optimizer_version_requires_optimization(self):
        path, _ = self.dataset()
        optimize_dataset(path, emit=lambda _: None)
        ds = lance.dataset(str(path))
        ds.delete('score = 6')
        expected = storage.logical_reader(lance.dataset(str(path)), path).read_all()
        self.assertIsInstance(optimize_dataset(path, emit=lambda _: None), tuple)
        self.assertEqual(storage.logical_reader(lance.dataset(str(path)), path).read_all(), expected)
        descriptor = json.loads((path / storage.DESCRIPTOR).read_text())
        descriptor['optimized']['version'] = 0
        (path / storage.DESCRIPTOR).write_text(json.dumps(descriptor))
        self.assertIsInstance(optimize_dataset(path, emit=lambda _: None), tuple)

    def test_unfinished_encoding_is_not_skipped(self):
        path = self.root / 'unindexed.lance'
        table = pa.table({'prompt': ['Blue CAT'], 'tags': ['CAT']})
        reader, pairs = storage.encoded_reader(table.to_reader())
        ds = lance.write_dataset(reader, str(path), data_storage_version='2.1')
        storage.write_descriptor(path, pairs)
        ds.create_scalar_index('prompt', 'NGRAM')
        ds.cleanup_old_versions(older_than=timedelta(0), delete_unverified=True)
        self.assertIsInstance(optimize_dataset(path, emit=lambda _: None), tuple)
        self.assertEqual({tuple(i['fields']) for i in lance.dataset(str(path)).list_indices()}, {('prompt',), ('tags',)})

    def test_final_report_lists_failures_and_excludes_skips_from_savings(self):
        from quarry_tools.optimize import _SKIPPED
        paths = [self.root / name for name in ('good.lance', 'done.lance', 'bad.lance')]
        output = io.StringIO()
        with patch('quarry_tools.optimize.find_datasets', return_value=paths), \
             patch('quarry_tools.optimize.optimize_dataset', side_effect=[(1000, 500), _SKIPPED, OSError('disk full\nretry later')]), \
             redirect_stdout(output), redirect_stderr(io.StringIO()):
            self.assertEqual(main(['lance', 'optimize', str(self.root)]), 1)
        report = output.getvalue()
        self.assertIn('1/3 dataset(s); 1 skipped; 1 failed', report)
        self.assertIn(f'Failed datasets:\n  {paths[2]}: disk full retry later', report)
        self.assertIn('50.0%', report)

    def test_completion_marker_failure_keeps_existing_descriptor(self):
        path, _ = self.dataset()
        storage.write_descriptor(path, {})
        before = (path / storage.DESCRIPTOR).read_bytes()
        with patch.object(Path, 'replace', side_effect=OSError('marker failure')), self.assertRaises(OSError):
            storage.write_descriptor(path, {}, optimized={'version': 1, 'lance_version': 1})
        self.assertEqual((path / storage.DESCRIPTOR).read_bytes(), before)
        self.assertFalse(list(path.glob('.*.tmp')))

    def test_descriptor_replacement_preserves_file_permissions(self):
        reference = self.root / 'reference.json'
        reference.write_text('{}')
        storage.write_descriptor(self.root, {})
        descriptor = self.root / storage.DESCRIPTOR
        self.assertEqual(descriptor.stat().st_mode & 0o777, reference.stat().st_mode & 0o777)
        descriptor.chmod(0o640)
        storage.write_descriptor(self.root, {}, optimized={'version': 1, 'lance_version': 1})
        self.assertEqual(descriptor.stat().st_mode & 0o777, 0o640)

    def test_write_retries_preserve_values_indexes_and_discard_partial_output(self):
        size_error = RuntimeError('Mini-block chunk size 35760 bytes exceeds the 32768 byte metadata limit')
        panic_type = type('PanicException', (BaseException,), {'__module__': 'pyo3_runtime'})
        for case, failures in enumerate(([size_error], [size_error, size_error],
                                         [panic_type('RecvError(())'), size_error],
                                         [panic_type(str(size_error))],
                                         [panic_type('assertion failed: chunk_bytes <= max_chunk_size')])):
            with self.subTest(failures=len(failures), first=type(failures[0]).__name__):
                path, expected = self.dataset(f'retry-{case}.lance')
                real_write = lance.write_dataset
                attempts = []
                messages = []

                def write(reader, destination, **kwargs):
                    self.assertFalse(Path(destination).exists())
                    attempts.append(reader.schema.field('prompt').metadata or {})
                    if len(attempts) <= len(failures):
                        # Consume data so a stale reader/digest would fail verification.
                        real_write(reader, destination, **kwargs)
                        raise failures[len(attempts) - 1]
                    return real_write(reader, destination, **kwargs)

                with patch.object(lance, 'write_dataset', side_effect=write), patch.object(
                    storage, 'logical_reader', wraps=storage.logical_reader,
                ) as readers:
                    optimize_dataset(path, emit=messages.append)
                ds = lance.dataset(str(path))
                self.assertEqual(storage.logical_reader(ds, path).read_all(), expected)
                self.assertEqual(len(ds.versions()), 1)
                self.assertEqual({(tuple(i['fields']), i['type']) for i in ds.list_indices()},
                                 {(('prompt',), 'NGram'), (('tags',), 'NGram'), (('score',), 'Bitmap')})
                self.assertEqual(len(attempts), len(failures) + 1)
                key = b'lance-encoding:structural-encoding'
                self.assertEqual([m.get(key) for m in attempts],
                                 [b'miniblock', b'miniblock'] + ([None] if len(failures) == 2 else []))
                self.assertEqual([c.kwargs['batch_rows'] for c in readers.call_args_list if 'batch_rows' in c.kwargs],
                                 [1024] * len(failures))
                self.assertTrue(any('1,024-row' in m for m in messages))
                self.assertEqual(any('default layout' in m for m in messages), len(failures) == 2)
                self.assertFalse(list(self.root.glob('.quarry-optimize-*')))
                with patch.object(lance, 'write_dataset', side_effect=AssertionError('rewrote fallback')):
                    self.assertEqual(self.cli('lance', 'optimize', str(path)), 0)

    def test_write_failure_and_cancellation_keep_original(self):
        path, _ = self.dataset()
        before = lance.dataset(str(path)).to_table()
        version = lance.dataset(str(path)).version
        panic_type = type('PanicException', (BaseException,), {'__module__': 'pyo3_runtime'})
        for error, attempts, raised in [
            (OSError('disk full'), 1, OSError),
            (KeyboardInterrupt(), 1, KeyboardInterrupt),
            (panic_type('unrelated native failure'), 1, FileError),
            (RuntimeError('Mini-block chunk size 35760 bytes exceeds the 32768 byte metadata limit'), 3, FileError),
        ]:
            with self.subTest(error=type(error).__name__), patch.object(
                lance, 'write_dataset', side_effect=error,
            ) as writer, self.assertRaises(raised):
                optimize_dataset(path, emit=lambda _: None)
            self.assertEqual(writer.call_count, attempts)
            self.assertEqual(lance.dataset(str(path)).to_table(), before)
            self.assertEqual(lance.dataset(str(path)).version, version)
            self.assertEqual(list(self.root.iterdir()), [path])

    def test_failure_before_publish_keeps_original(self):
        path, _ = self.dataset()
        before = lance.dataset(str(path)).to_table()
        version = lance.dataset(str(path)).version
        for target in ['quarry_tools.storage.verify_dataset', 'quarry_tools.lance._build_one']:
            with patch(target, side_effect=RuntimeError('injected failure')), self.assertRaises(RuntimeError):
                optimize_dataset(path, emit=lambda _: None)
            self.assertEqual(lance.dataset(str(path)).to_table(), before)
            self.assertEqual(lance.dataset(str(path)).version, version)
            self.assertEqual(list(self.root.iterdir()), [path])

    def test_publish_failure_restores_original(self):
        path, _ = self.dataset()
        before = lance.dataset(str(path)).to_table()
        rename = Path.rename
        def fail_staged(p, destination):
            if p.name == 'dataset.lance':
                raise OSError('injected publish failure')
            return rename(p, destination)
        with patch.object(Path, 'rename', fail_staged), self.assertRaises(OSError):
            optimize_dataset(path, emit=lambda _: None)
        self.assertEqual(lance.dataset(str(path)).to_table(), before)

    def test_collisions_and_unsupported_indices_leave_source_unchanged(self):
        path = self.root / 'collision.lance'
        ds = lance.write_dataset(pa.table({'prompt': ['CAT'], 'prompt__case': [b'user data']}), str(path))
        with self.assertRaisesRegex(FileError, 'conflicts'):
            optimize_dataset(path, emit=lambda _: None)
        self.assertEqual(lance.dataset(str(path)).version, ds.version)
        path, _ = self.dataset()
        ds = lance.dataset(str(path)); ds.create_scalar_index('tags', 'BTREE')
        with self.assertRaisesRegex(FileError, 'case-sensitive'):
            optimize_dataset(path, emit=lambda _: None)

    def test_preserved_index_name_cannot_collide_with_generated_ngram(self):
        path = self.root / 'names.lance'
        ds = lance.write_dataset(pa.table({'prompt': ['CAT'], 'score': [1]}), str(path))
        ds.create_scalar_index('score', 'BITMAP', name='prompt_idx')
        optimize_dataset(path, emit=lambda _: None)
        indexes = lance.dataset(str(path)).list_indices()
        self.assertEqual({(i['name'], i['type']) for i in indexes},
                         {('prompt_idx', 'Bitmap'), ('prompt_idx_ngram', 'NGram')})

    def test_prep_encoded_input_decodes_before_selection_and_renaming(self):
        path, _ = self.dataset()
        optimize_dataset(path, emit=lambda _: None)
        output = self.root / 'prepared.lance'
        self.assertEqual(self.cli('prep', str(path), '-o', str(output), '--columns', 'tags=prompt;score'), 0)
        ds = lance.dataset(str(output))
        self.assertEqual(json.loads((output / storage.DESCRIPTOR).read_text())['optimized']['lance_version'], ds.version)
        self.assertEqual(storage.logical_reader(ds, output).read_all()['prompt'].to_pylist(), ['Art', 'ÉCOLE', 'City', 'SPACE'])
        self.assertEqual(self.cli('columns', 'reorder', str(output), 'score,prompt'), 0)
        self.assertEqual(self.cli('lance', 'prep', str(output)), 1)
        self.assertEqual(self.cli('lance', 'prep', str(output), '--no-clean'), 0)
        self.assertNotIn('prompt__lc', lance.dataset(str(output)).schema.names)

    def test_reorder_preserves_casing_metadata_values_layout_and_indexes(self):
        path, expected = self.dataset()
        optimize_dataset(path, emit=lambda _: None)
        before = lance.dataset(str(path))
        physical = before.to_table()
        descriptor = (path / storage.DESCRIPTOR).read_bytes()
        indexes = {(i['name'], tuple(i['fields']), i['type']) for i in before.list_indices()}
        self.assertEqual(self.cli('columns', 'reorder', str(path), 'score,tags,prompt'), 0)
        after = lance.dataset(str(path))
        self.assertEqual(after.schema.names, ['score', 'tags', 'prompt', 'prompt__case', 'tags__case'])
        self.assertEqual(after.to_table(), physical.select(after.schema.names))
        self.assertEqual(storage.logical_reader(after, path).read_all(), expected.select(['score', 'tags', 'prompt']))
        self.assertEqual((path / storage.DESCRIPTOR).read_bytes(), descriptor)
        self.assertEqual({(i['name'], tuple(i['fields']), i['type']) for i in after.list_indices()}, indexes)
        self.assertEqual(after.schema.field('prompt').metadata, before.schema.field('prompt').metadata)
        self.assertEqual(len(after.versions()), 1)
        self.assertEqual(list(self.root.iterdir()), [path])

    def test_reorder_keeps_legacy_index_on_its_companion(self):
        path, _ = self.dataset()
        before = lance.dataset(str(path)).to_table()
        self.assertEqual(self.cli('columns', 'reorder', str(path), 'score'), 0)
        after = lance.dataset(str(path))
        self.assertEqual(after.to_table(), before.select(after.schema.names))
        self.assertFalse((path / storage.DESCRIPTOR).exists())
        self.assertIn((('prompt__lc',), 'NGram'),
                      {(tuple(i['fields']), i['type']) for i in after.list_indices()})

    def test_reorder_index_failure_keeps_original_dataset_and_descriptor(self):
        path, _ = self.dataset()
        optimize_dataset(path, emit=lambda _: None)
        before = lance.dataset(str(path)).to_table()
        descriptor = (path / storage.DESCRIPTOR).read_bytes()
        with patch.object(lance.LanceDataset, 'create_scalar_index', side_effect=RuntimeError('index failed')):
            self.assertEqual(self.cli('columns', 'reorder', str(path), 'score,prompt'), 1)
        self.assertEqual(lance.dataset(str(path)).to_table(), before)
        self.assertEqual((path / storage.DESCRIPTOR).read_bytes(), descriptor)
        self.assertEqual(list(self.root.iterdir()), [path])

    def test_reorder_failed_publication_and_rollback_retains_recoverable_original(self):
        import os
        from quarry_tools.columns import _reorder_lance

        path, _ = self.dataset()
        optimize_dataset(path, emit=lambda _: None)
        before = lance.dataset(str(path)).to_table()
        descriptor = (path / storage.DESCRIPTOR).read_bytes()
        replace = os.replace

        def fail_after_backup(source, destination):
            if Path(destination) == path:
                raise OSError('injected publication/rollback failure')
            return replace(source, destination)

        with patch('os.replace', side_effect=fail_after_backup):
            with self.assertRaisesRegex(FileError, 'recover it from'):
                _reorder_lance(path, ['score'])
        backup = next(self.root.glob('.*/*.bak'))
        self.assertEqual(lance.dataset(str(backup)).to_table(), before)
        self.assertEqual((backup / storage.DESCRIPTOR).read_bytes(), descriptor)

    def test_orphan_legacy_suffix_is_preserved_and_indexed(self):
        path = self.root / 'orphan.lance'
        lance.write_dataset(pa.table({'notes__lc': ['Original CASE']}), str(path))
        optimize_dataset(path, emit=lambda _: None)
        ds = lance.dataset(str(path))
        self.assertEqual(storage.logical_reader(ds, path).read_all()['notes__lc'].to_pylist(), ['Original CASE'])
        self.assertEqual({tuple(i['fields']) for i in ds.list_indices()}, {('notes__lc',)})

    def test_old_prep_checkpoint_is_upgraded_on_resume(self):
        work = self.root / '.quarry-prep-old'; work.mkdir()
        staged = work / 'dataset.lance'
        lance.write_dataset(pa.table({'prompt': ['Original CASE']}), str(staged))
        output = self.root / 'out.lance'
        (work / 'prep.json').write_text(json.dumps({'version': 1, 'output': str(output), 'prompt_column': 'prompt'}))
        self.assertEqual(self.cli('prep', '--resume', str(work)), 0)
        self.assertEqual(storage.logical_reader(lance.dataset(str(output)), output).read_all()['prompt'].to_pylist(), ['Original CASE'])
        self.assertFalse(work.exists())


if __name__ == '__main__':
    unittest.main()
