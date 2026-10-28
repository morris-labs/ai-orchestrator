"""Exits 1 when a report name escapes the reports directory."""
import os
import sys

sys.path.insert(0, sys.argv[1])
sys.dont_write_bytecode = True
try:
    from shop.reports import REPORT_DIR, report_path
except ImportError:
    sys.exit(0)  # The code under test does not exist here.

try:
    path = report_path("../../etc/passwd")
except ValueError:
    sys.exit(0)
if not os.path.abspath(path).startswith(os.path.abspath(REPORT_DIR) + os.sep):
    print(f"report_path escapes to {path}")
    sys.exit(1)
