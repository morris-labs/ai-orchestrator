"""A small lint: every Python file compiles and has no tabs or trailing spaces."""
import pathlib
import py_compile
import sys

problems = []
for path in sorted(pathlib.Path(".").rglob("*.py")):
    if any(part.startswith(".") for part in path.parts):
        continue
    try:
        py_compile.compile(str(path), doraise=True)
    except py_compile.PyCompileError as error:
        problems.append(f"{path}: does not compile: {error.msg}")
    for number, line in enumerate(path.read_text().splitlines(), 1):
        if "\t" in line:
            problems.append(f"{path}:{number}: tab character")
        if line != line.rstrip():
            problems.append(f"{path}:{number}: trailing whitespace")
for problem in problems:
    print(f"ERROR {problem}")
sys.exit(1 if problems else 0)
