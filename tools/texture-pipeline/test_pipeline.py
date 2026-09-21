import unittest
import numpy as np
import compressor
import validator

class TextureRegressionTests(unittest.TestCase):
    def test_odd_mips_match_webgl_dimensions(self):
        for width, height in [(1532, 768), (17, 9), (1, 17), (8, 8)]:
            image = np.ones((height, width, 4), dtype=np.float32)
            levels = compressor._mipmaps(image, True)
            for level in levels:
                self.assertEqual(level.shape[:2], (height, width))
                np.testing.assert_allclose(level, 1, atol=1e-6)
                width, height = max(1, width // 2), max(1, height // 2)
            self.assertEqual(levels[-1].shape[:2], (1, 1))

    def test_black_animation_frame_is_valid(self):
        blank = np.zeros((16, 16, 3), dtype=np.float32)
        self.assertTrue(validator.validate(blank, blank)['passed'])
        self.assertFalse(validator.validate(blank, np.ones_like(blank))['passed'])
        patterned = blank.copy()
        patterned[:8] = 1
        self.assertFalse(validator.validate(blank, patterned)['passed'])

if __name__ == '__main__':
    unittest.main()
