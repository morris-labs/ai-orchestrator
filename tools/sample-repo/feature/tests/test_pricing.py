import unittest

from shop.pricing import apply_discount, average_price, bulk_discount


class ApplyDiscountTest(unittest.TestCase):
    def test_half_off(self):
        self.assertEqual(apply_discount(10.0, 50), 5.0)

    def test_rejects_negative_percent(self):
        with self.assertRaises(ValueError):
            apply_discount(10.0, -1)


class BulkDiscountTest(unittest.TestCase):
    def test_large_order(self):
        self.assertEqual(bulk_discount(150), 10)

    def test_medium_order(self):
        self.assertEqual(bulk_discount(60), 5)

    def test_small_order(self):
        self.assertEqual(bulk_discount(3), 0)


class AveragePriceTest(unittest.TestCase):
    def test_mean(self):
        self.assertEqual(average_price([1.0, 2.0, 3.0]), 2.0)


if __name__ == "__main__":
    unittest.main()
