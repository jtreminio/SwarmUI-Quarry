"""Correctness checks for the benchmark's experimental lossless case encoding."""

import random
import sys
from pathlib import Path
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "benchmarks"))
from lance_storage import case_patch, restore_case, variants


class CasePatchTests(unittest.TestCase):
    def test_roundtrip_ascii_unicode_null_and_nonmatching_companion(self):
        cases = [None, "", "all lowercase", "A Blue CAT", "NASA " * 100,
                 "İstanbul", "ΟΣ", "ẞtraße", "Hello 🐈 World", "Tamaki’s Blue Bow",
                 "x" * 10000 + "Z", "\x00A\nB\tC"]
        for original in cases:
            lower = original.lower() if original is not None else None
            for codec in ("adaptive", "sparse", "bitmap"):
                with self.subTest(original=original, codec=codec):
                    self.assertEqual(restore_case(lower, case_patch(original, lower, codec)), original)
        self.assertEqual(restore_case("different", case_patch("Original", "different")), "Original")

    def test_randomized_roundtrips_and_adaptive_selects_smallest(self):
        rng = random.Random(20260916)
        alphabet = "abcXYZ09 \n\tİΟΣẞßé猫🙂"
        for _ in range(250):
            original = "".join(rng.choices(alphabet, k=rng.randrange(400)))
            lower = original.lower()
            patches = {codec: case_patch(original, lower, codec) for codec in ("adaptive", "sparse", "bitmap")}
            for patch in patches.values():
                self.assertEqual(restore_case(lower, patch), original)
            self.assertLessEqual(len(patches["adaptive"]), min(len(patches["sparse"]), len(patches["bitmap"])))

    def test_factorial_matrix_and_controls(self):
        matrix = variants()
        self.assertEqual(len({v["name"] for v in matrix}), len(matrix))
        self.assertEqual(len({(v["compression"] == "zstd", v["casing"], v["selective"])
                              for v in matrix[:8]}), 8)
        self.assertIn("layout_only", {v["name"] for v in matrix})
        self.assertIn("originals_zstd", {v["name"] for v in matrix})


if __name__ == "__main__":
    unittest.main()
