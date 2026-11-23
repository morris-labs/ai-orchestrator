# AC1: add_tax returns the price plus tax, rounded to cents.
import unittest

from shop.tax import add_tax


class AddTaxTest(unittest.TestCase):
    def test_adds_tax_rounded_to_cents(self):
        self.assertEqual(add_tax(20.00, 0.08), 21.6)

    def test_zero_rate_keeps_the_price(self):
        self.assertEqual(add_tax(4.50, 0), 4.50)


if __name__ == "__main__":
    unittest.main()
