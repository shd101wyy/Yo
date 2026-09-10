"""sizeof for EVERY emitted struct/enum type: /tmp/re/sizes.txt as "mangled size"."""
import os
import re
import subprocess
import sys
from pathlib import Path

_ALLOWED_WRITE_ROOTS = (os.path.abspath("."), os.path.abspath("/tmp"))


def _no_traversal(p):
    """Dev-tool write guard: normalize the path, refuse any `..` component,
    and confine the result to an allowed root (repo cwd or /tmp), so a
    mistyped argument cannot write outside the intended tree."""
    if ".." in p.replace("\\", "/").split("/"):
        sys.exit("refusing path with '..' component: %s" % p)
    abs_p = os.path.abspath(os.path.normpath(p))
    if not any(abs_p == r or abs_p.startswith(r + os.sep) for r in _ALLOWED_WRITE_ROOTS):
        sys.exit("refusing path outside allowed roots (cwd, /tmp): %s" % p)
    return abs_p

SRC = sys.argv[1] if len(sys.argv) > 1 else "/tmp/re/s1r9.c"
src = open(SRC).read()
i = src.find("// Function implementations")
if i < 0:
    i = src.find("// Function declarations")
prefix = "\n".join(
    L for L in src[:i].split("\n")
    if not re.match(r"^(static|extern)?\s*[A-Za-z_][\w \*]*\s+\w+\s*=\s*.*fn_yo", L)
)

names = sorted(set(re.findall(r"struct (__yo_(?:struct|enum)_yo\w+_id_\d+)_struct \{", src)))
body = ['\n#include <stdio.h>\nint main(void){']
for n in names:
    body.append('  printf("%s %%zu\\n", sizeof(%s));' % (n, n))
body.append("  return 0;\n}\n")
Path(_no_traversal("/tmp/re/sizeof_all.c")).write_text(prefix + "\n".join(body))
r = subprocess.run(
    ["clang", "-std=c11", "-w", "-O0", "/tmp/re/sizeof_all.c", "-o", "/tmp/re/sizeof_all"],
    capture_output=True, text=True,
)
if r.returncode != 0:
    print("BUILD FAILED")
    print(r.stderr[-2000:])
    sys.exit(1)
out = subprocess.run(["/tmp/re/sizeof_all"], capture_output=True, text=True).stdout
Path(_no_traversal("/tmp/re/sizes.txt")).write_text(out)
print("sizes for", len(out.strip().split("\n")), "types")
