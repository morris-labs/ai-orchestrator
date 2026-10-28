"""Exits 1 when average_stock fails on an empty list."""
import sys

sys.path.insert(0, sys.argv[1])
sys.dont_write_bytecode = True
try:
    from shop.inventory import average_stock
except ImportError:
    sys.exit(0)  # The code under test does not exist here.

try:
    average_stock([])
except ZeroDivisionError:
    print("average_stock([]) raises ZeroDivisionError")
    sys.exit(1)
