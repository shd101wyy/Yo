import os
import re
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

src = open("/tmp/re/s1in.c").read()
names = []


def inject(m):
    sig, name = m.group(0), m.group(1)
    names.append(name)
    return sig + "\n  __yo_ctor_count[%d]++;" % (len(names) - 1)


out = re.sub(
    r"static __yo_(?:struct|enum)_\w+\* (__yo_new_\w+)\([^)]*\) \{", inject, src
)
n = len(names)
header = "static unsigned long long __yo_ctor_count[%d];\n" % n
table = (
    "static const char* __yo_ctor_names[] = {"
    + ",".join('"%s"' % x for x in names)
    + "};\n"
)
dump = (
    "\n#include <stdio.h>\n"
    "__attribute__((destructor)) static void __yo_ctor_dump(void) {\n"
    '  FILE* f = fopen("/tmp/re/ctor_counts.txt", "w");\n'
    "  if (!f) return;\n"
    "  for (int i = 0; i < %d; i++) if (__yo_ctor_count[i]) "
    'fprintf(f, "%%llu %%s\\n", __yo_ctor_count[i], __yo_ctor_names[i]);\n'
    "  fclose(f);\n"
    "}\n"
) % n
idx = out.find("// Function implementations")
if idx < 0:
    idx = out.find("static void __yo_dispose_dispatch")
out = out[:idx] + header + table + dump + out[idx:]
Path(_no_traversal("/tmp/re/s1count.c")).write_text(out)
print("instrumented", n, "constructors")
