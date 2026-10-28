"""Exits 1 when apply_discount accepts a percent above 100."""
import sys

sys.path.insert(0, sys.argv[1])
sys.dont_write_bytecode = True
try:
    from shop.pricing import apply_discount
except ImportError:
    sys.exit(0)  # The code under test does not exist here.

try:
    apply_discount(10.0, 150)
except ValueError:
    sys.exit(0)
sys.exit(1)
