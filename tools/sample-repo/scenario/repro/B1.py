"""Exits 1 when average_price fails on an empty list."""
import sys

sys.path.insert(0, sys.argv[1])
sys.dont_write_bytecode = True
try:
    from shop.pricing import average_price
except ImportError:
    sys.exit(0)  # The code under test does not exist here.

try:
    average_price([])
except ZeroDivisionError:
    print("average_price([]) raises ZeroDivisionError")
    sys.exit(1)
