"""Exits 1 when an order of exactly 100 items misses the 10 percent discount."""
import sys

sys.path.insert(0, sys.argv[1])
sys.dont_write_bytecode = True
try:
    from shop.pricing import bulk_discount
except ImportError:
    sys.exit(0)  # The code under test does not exist here.

if bulk_discount(100) != 10:
    print(f"bulk_discount(100) == {bulk_discount(100)}")
    sys.exit(1)
