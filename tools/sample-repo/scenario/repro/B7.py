"""Exits 1 when round_currency truncates instead of rounding."""
import sys

sys.path.insert(0, sys.argv[1])
sys.dont_write_bytecode = True
try:
    from shop.pricing import round_currency
except ImportError:
    sys.exit(0)  # The code under test does not exist here.

if round_currency(0.29) != 0.29:
    print(f"round_currency(0.29) == {round_currency(0.29)}")
    sys.exit(1)
