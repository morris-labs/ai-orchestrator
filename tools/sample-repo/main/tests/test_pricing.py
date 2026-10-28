import unittest

from shop.pricing import apply_discount


class ApplyDiscountTest(unittest.TestCase):
    def test_half_off(self):
        self.assertEqual(apply_discount(10.0, 50), 5.0)

    def test_rejects_negative_percent(self):
        with self.assertRaises(ValueError):
            apply_discount(10.0, -1)


if __name__ == "__main__":
    unittest.main()
