import unittest

from shop.inventory import total_stock


class TotalStockTest(unittest.TestCase):
    def test_sum(self):
        self.assertEqual(total_stock([1, 2, 3]), 6)


if __name__ == "__main__":
    unittest.main()
