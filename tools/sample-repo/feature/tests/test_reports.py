import os
import tempfile
import unittest

from shop.reports import report_path, write_report


class ReportTest(unittest.TestCase):
    def test_path(self):
        self.assertEqual(report_path("daily"), os.path.join("reports", "daily.txt"))

    def test_write(self):
        cwd = os.getcwd()
        with tempfile.TemporaryDirectory() as tmp:
            os.chdir(tmp)
            try:
                path = write_report("daily", [1, 2])
                with open(path) as handle:
                    self.assertEqual(handle.read(), "total: 3\n")
            finally:
                os.chdir(cwd)


if __name__ == "__main__":
    unittest.main()
