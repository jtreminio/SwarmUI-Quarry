"""Lossless JSON discovery and complete structured prompt cleanup."""
import json
from pathlib import Path
import sys
import tempfile
import unittest

import pyarrow as pa

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from quarry_tools.common import FileError
from quarry_tools.json_schema import open_json_source, rows, validate_empty_selections
from quarry_tools.prep import open_source, selected_reader
from quarry_tools.prep_clean import cleaned_reader
from quarry_tools.structured import prompt_key
from quarry_tools.lance import process_dataset


class StructuredPreparationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def source(self, values, fmt='jsonl'):
        path = self.root / ('input.' + fmt)
        path.write_text(json.dumps(values) if fmt == 'json' else '\n'.join(json.dumps(v) for v in values))
        return path

    def read(self, values, fmt='jsonl'):
        path = self.source(values, fmt)
        original = path.read_bytes()
        with open_json_source(path, fmt, 2) as (schema, count, batches):
            table = batches(schema.names).read_all()
        self.assertEqual(path.read_bytes(), original)
        self.assertEqual(count, len(values))
        return table

    def clean(self, values, dtype):
        table = pa.table({'prompt': pa.array(values, type=dtype), 'metadata': list(range(len(values)))})
        with cleaned_reader(table.to_reader(max_chunksize=2), 'prompt', self.root,
                            batch_rows=2, memory_limit='64MB', emit=lambda _: None) as reader:
            result = reader.read_all()
        return table, result

    def test_complete_schema_retains_late_fields_and_first_seen_order(self):
        values = [{'subject': [{'early': 'A'}]} for _ in range(2050)] + [
            {'subject': [{'late': '2026-09-16', 'early': 'B', 'nullable': None}]}]
        table = self.read(values)
        self.assertEqual([f.name for f in table.schema.field('subject').type.value_type], ['early', 'late', 'nullable'])
        self.assertEqual(table.column('subject')[-1].as_py(), [{'early': 'B', 'late': '2026-09-16', 'nullable': None}])
        self.assertTrue(pa.types.is_string(table.schema.field('subject').type.value_type.field('nullable').type))

    def test_scalar_types_bounds_and_quoted_field_names(self):
        name = 'key";(), odd'
        rows = [{'subject': [{name: '2026-01-01', 'i': -(2**63), 'u': 2**64 - 1, 'f': 1.5, 'b': False}]},
                {'subject': [{name: '2026-01-02', 'i': 2**63 - 1, 'u': 0, 'f': -0.0, 'b': True}]}]
        self.assertEqual(self.read(rows).to_pylist(), rows)

    def test_mixed_types_overflow_and_nested_values_rejected(self):
        cases = [([1, '1'], 'incompatible'), ([1, 1.5], 'incompatible'),
                 ([True, 1], 'incompatible'), ([-1, 2**64 - 1], '64-bit'),
                 ([2**64], '64-bit'), ([-(2**63) - 1], '64-bit'),
                 ([[1]], 'direct scalar'), ([{'nested': 'x'}], 'direct scalar')]
        for values, message in cases:
            with self.subTest(values=values), self.assertRaisesRegex(FileError, message):
                self.read([{'subject': [{'value': value}]} for value in values])

    def test_direct_objects_reject_nested_lists_and_objects(self):
        for value in ([1], {'inner': 'x'}):
            with self.subTest(value=value), self.assertRaisesRegex(FileError, 'direct scalar'):
                self.read([{'prompt': {'value': value}}])

    def test_case_collisions_rejected_in_one_or_different_rows(self):
        for values in ([{'prompt': {'hair': 'a', 'Hair': 'b'}}],
                       [{'prompt': {'hair': 'a'}}, {'prompt': {'Hair': 'b'}}]):
            with self.assertRaisesRegex(FileError, 'case'):
                self.read(values)

    def test_legacy_simple_lists_and_json_document_forms(self):
        values = [{'prompt': ['first', 'second']}, {'prompt': ['third']}]
        self.assertEqual(self.read(values, 'json').to_pylist(), values)
        path = self.root / 'single.json'
        path.write_text(json.dumps(values[0]))
        self.assertEqual(list(rows(path, 'json')), values[:1])
        path.write_text('[{"prompt":"' + ('x' * 70000) + '"}, {"prompt":"last"}]')
        self.assertEqual([len(v['prompt']) for v in rows(path, 'json')], [70000, 4])
        for invalid in ('[{},]', '[{}] {}', '[1]', '{', '[{}'):
            path.write_text(invalid)
            with self.subTest(invalid=invalid), self.assertRaises(FileError):
                list(rows(path, 'json'))

    def test_empty_scalar_lists_remain_valid_metadata_and_flatten_to_empty_text(self):
        values = [{'prompt': 'First', 'tags': []}, {'prompt': 'Second', 'tags': [None]}]
        path = self.source(values)
        with open_source(path, 'jsonl', 2) as (schema, _, batches):
            self.assertTrue(pa.types.is_list(schema.field('tags').type))
            self.assertTrue(pa.types.is_string(schema.field('tags').type.value_type))
            selected = [('prompt', 'prompt'), ('tags', 'tags')]
            validate_empty_selections(schema, selected, 'prompt')
            with cleaned_reader(selected_reader(schema, batches, selected), 'prompt', self.root,
                                batch_rows=2, emit=lambda _: None) as reader:
                self.assertEqual(reader.read_all().to_pylist(), [
                    {'prompt': 'First', 'tags': ''}, {'prompt': 'Second', 'tags': ''}])

    def test_schema_less_prompt_is_empty_and_nonprompt_is_rejected(self):
        for value in ({}, [{}]):
            path = self.source([{'subject': value}, {'subject': value}])
            with open_json_source(path, 'jsonl', 2) as (schema, _, batches):
                validate_empty_selections(schema, [('subject', 'prompt')], 'prompt')
                with self.assertRaisesRegex(FileError, 'only empty structures'):
                    validate_empty_selections(schema, [('subject', 'metadata')], 'prompt')
                self.assertEqual(batches(['subject']).read_all().column(0).to_pylist(), [None, None])

    def test_complete_list_identity_preserves_positions_boundaries_and_first_metadata(self):
        record = pa.struct([('hair', pa.string()), ('eyes', pa.string())])
        dtype = pa.list_(record)
        a, b, c = {'hair': 'Blond!', 'eyes': 'Blue'}, {'hair': 'Red'}, {'hair': 'Black'}
        values = [[a, b], [{'hair': 'b l o n d', 'eyes': 'blue'}, {'hair': 'red!'}],
                  [a, c], [b, a], [a, a], [a], [a, None], [a, {}],
                  [{'hair': 'ab', 'eyes': 'c'}], [{'hair': 'a', 'eyes': 'bc'}]]
        source, result = self.clean(values, dtype)
        self.assertEqual(result, source.take(pa.array([0, 2, 3, 4, 5, 6, 7, 8, 9])))

    def test_empty_lists_later_records_punctuation_unicode_and_typed_values(self):
        dtype = pa.list_(pa.struct([('text', pa.string()), ('number', pa.int64()), ('flag', pa.bool_())]))
        values = [None, [], [{}], [None], [{'text': '  '}],
                  [{}, {'text': 'Kept'}], [None, {'text': 'kept'}],
                  [{'text': '!!!'}], [{'text': '!!!'}], [{'text': '\t'}],
                  [{'text': 'İ'}], [{'text': 'i'}], [{'number': 0}], [{'flag': False}],
                  [{'text': '²'}], [{'text': '2'}], [{'text': 'é'}], [{'text': 'e\u0301'}]]
        source, result = self.clean(values, dtype)
        self.assertEqual(result, source.take(pa.array([5, 6, 7, 8, 9, 10, 12, 13, 14, 15, 16, 17])))

    def test_direct_object_null_empty_and_punctuation_leaf_policy(self):
        dtype = pa.struct([('text', pa.string()), ('note', pa.string())])
        values = [{'text': 'cat', 'note': '!!!'}, {'text': 'Cat!', 'note': '???'},
                  {'text': 'cat', 'note': None}, {'text': 'cat', 'note': ''}, {'text': 'cat'}, {}]
        source, result = self.clean(values, dtype)
        self.assertEqual(result, source.take(pa.array([0, 2])))

    def test_prep_rename_preserves_later_subject_and_deduplicates_whole_prompt(self):
        values = [
            {'subject': [{'hair': 'Blond'}, {'hair': 'Red'}], 'style': 'First'},
            {'subject': [{'hair': 'blond!'}, {'hair': 'r e d'}], 'style': 'Duplicate'},
            {'subject': [{'hair': 'Blond'}, {'hair': 'Black'}], 'style': 'Different'},
            {'subject': [{}, {'hair': 'Kept'}], 'style': 'Later'},
        ]
        path = self.source(values)
        with open_source(path, 'jsonl', 2) as (schema, _, batches):
            selected = [('subject', 'prompt'), ('style', 'style')]
            validate_empty_selections(schema, selected, 'prompt')
            with cleaned_reader(selected_reader(schema, batches, selected), 'prompt', self.root,
                                batch_rows=2, emit=lambda _: None) as reader:
                result = reader.read_all().to_pylist()
        self.assertEqual([row['style'] for row in result], ['First', 'Different', 'Later'])
        self.assertEqual(result[-1]['prompt'], [{'hair': None}, {'hair': 'Kept'}])
        self.assertEqual(result[0]['prompt'], values[0]['subject'])

    def test_explicit_lance_cleanup_shares_complete_prompt_policy_and_dry_run(self):
        import lance

        dtype = pa.list_(pa.struct([('hair', pa.string())]))
        values = [None, [], [{}], [{'hair': 'Blond'}, {'hair': 'Red'}],
                  [{'hair': 'blond!'}, {'hair': 'red'}], [{'hair': 'Blond'}, {'hair': 'Black'}],
                  [{}, {'hair': 'Later'}], [{'hair': '!!!'}], [{'hair': '!!!'}]]
        table = pa.table({'prompt': pa.array(values, type=dtype), 'id': list(range(len(values)))})
        path = self.root / 'cleanup.lance'
        lance.write_dataset(table, str(path))
        before = lance.dataset(str(path)).version
        result = process_dataset(path, None, True, False, True, True)
        self.assertEqual((result['empty'], result['duplicate']), (3, 1))
        self.assertEqual(lance.dataset(str(path)).version, before)
        result = process_dataset(path, None, False, False, True, True)
        self.assertEqual((result['empty_removed'], result['duplicate_removed']), (3, 1))
        self.assertEqual(lance.dataset(str(path)).to_table(), table.take(pa.array([3, 5, 6, 7, 8])))

    def test_explicit_lance_cleanup_respects_no_dedup(self):
        import lance

        dtype = pa.struct([('text', pa.string())])
        table = pa.table({'prompt': pa.array([{}, {'text': 'Hi'}, {'text': 'hi'}], type=dtype)})
        path = self.root / 'no-dedup.lance'
        lance.write_dataset(table, str(path))
        result = process_dataset(path, None, False, False, False, False)
        self.assertEqual((result['empty_removed'], result['duplicate_removed']), (1, 0))
        self.assertEqual(lance.dataset(str(path)).to_table(), table.slice(1))

    def test_scalar_types_and_internal_name_collisions(self):
        self.assertNotEqual(prompt_key('1', pa.string()), prompt_key(1, pa.int64()))
        self.assertNotEqual(prompt_key(True, pa.bool_()), prompt_key(1, pa.int64()))
        dtype = pa.struct([('text', pa.string())])
        table = pa.table({'prompt': pa.array([{'text': 'Hi'}, {'text': 'hi'}], type=dtype),
                          '__quarry_key': ['original', 'later'], '__quarry_order': [4, 5],
                          '__quarry_nonempty': [False, True]})
        with cleaned_reader(table.to_reader(), 'prompt', self.root, emit=lambda _: None) as reader:
            self.assertEqual(reader.read_all(), table.slice(0, 1))


if __name__ == '__main__':
    unittest.main()
