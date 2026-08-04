"""sizeof for EVERY emitted struct/enum type: /tmp/re/sizes.txt as "mangled size"."""
import re
import subprocess
import sys

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
open("/tmp/re/sizeof_all.c", "w").write(prefix + "\n".join(body))
r = subprocess.run(
    ["clang", "-std=c11", "-w", "-O0", "/tmp/re/sizeof_all.c", "-o", "/tmp/re/sizeof_all"],
    capture_output=True, text=True,
)
if r.returncode != 0:
    print("BUILD FAILED")
    print(r.stderr[-2000:])
    sys.exit(1)
out = subprocess.run(["/tmp/re/sizeof_all"], capture_output=True, text=True).stdout
open("/tmp/re/sizes.txt", "w").write(out)
print("sizes for", len(out.strip().split("\n")), "types")
