import unittest

from shop.inventory import add_item, average_stock, page, total_stock


class TotalStockTest(unittest.TestCase):
    def test_sum(self):
        self.assertEqual(total_stock([1, 2, 3]), 6)


class AverageStockTest(unittest.TestCase):
    def test_mean(self):
        self.assertEqual(average_stock([2, 4]), 3)


class PageTest(unittest.TestCase):
    def test_first_page(self):
        self.assertEqual(page(list(range(10)), 0, 3), [0, 1, 2])


class AddItemTest(unittest.TestCase):
    def test_adds(self):
        stock = add_item({}, "pen", 3)
        self.assertEqual(stock["pen"]["qty"], 3)


if __name__ == "__main__":
    unittest.main()
