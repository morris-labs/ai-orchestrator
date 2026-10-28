"""Plain-text reports written under the reports directory."""
import os

from shop.inventory import total_stock

REPORT_DIR = "reports"


def report_path(name):
    """Return the path of the report called `name`."""
    return os.path.join(REPORT_DIR, name + ".txt")


def write_report(name, levels):
    """Write a stock report and return its path."""
    path = report_path(name)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as handle:
        handle.write(f"total: {total_stock(levels)}\n")
    return path
