import re

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
open("/tmp/re/s1count.c", "w").write(out)
print("instrumented", n, "constructors")
