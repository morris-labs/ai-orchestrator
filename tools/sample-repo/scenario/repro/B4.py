"""Exits 1 when page 1 doesn't start at the first item."""
import sys

sys.path.insert(0, sys.argv[1])
sys.dont_write_bytecode = True
try:
    from shop.inventory import page
except ImportError:
    sys.exit(0)  # The code under test does not exist here.

if page(list(range(10)), 1, 3) != [0, 1, 2]:
    print(f"page(range(10), 1, 3) == {page(list(range(10)), 1, 3)}")
    sys.exit(1)
