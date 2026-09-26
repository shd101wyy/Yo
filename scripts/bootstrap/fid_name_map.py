"""Map emitted-C function names back to Yo names, from YO_DEBUG_FN_ORIGIN comments.

The pre-#914 version of this script rehashed every `->` position in src/ and
std/ to reverse `stable_func_id`'s fnv1a64 — it maps nothing on a current
tree (anchored ids). The reliable source is the compiler itself: emit the C
with `YO_DEBUG_FN_ORIGIN=1` and every definition is preceded by

    /* yo-origin <module_path>:<line> <c_function_name> */

(.github/instructions/debugging.instructions.md, "Naming yo_id_… frames").
This parses those comments and resolves each to the nearest `name ::` at or
above the line, which is the definition the position sits in.

Usage (from the checkout that produced the C, with the same cwd spelling the
compile used):
  YO_DEBUG_FN_ORIGIN=1 yo compile src/main.yo --emit-c --skip-c-compiler -o fresh.c
  python3 scripts/bootstrap/fid_name_map.py fresh.c fidmap.tsv
Output rows: `<c name>\t<file>:<line>\t<name>`, the format
rc_event_report.py's fidmap argument expects. Coverage is every yo-origin
comment in the C (2026-09-26 self-emit: 4.9 k names); definitions the
compiler mints with no source position are still unmapped.
"""
import os, re, sys

c_path, out_path = sys.argv[1], sys.argv[2]
c = open(c_path, errors="replace").read()

# module path spellings seen in the wild: `file://<abs>`, a path relative to
# the compile's cwd (`src/main.yo`, `./src/main.yo`), or an abs path.
def resolve(mod):
    if mod.startswith("file://"):
        mod = mod[len("file://"):]
    if os.path.exists(mod):
        return mod
    return None

srcs = {}
rows = 0
with open(out_path, "w") as out:
    for m in re.finditer(r"/\* yo-origin (\S+):(\d+) (\S+) \*/", c):
        mod, line, cname = m.group(1), int(m.group(2)), m.group(3)
        path = resolve(mod)
        if path is None:
            continue
        if path not in srcs:
            defs = []  # (line, name), ascending
            for r, text in enumerate(open(path, errors="replace").read().split("\n"), 1):
                d = re.match(r"\s*([A-Za-z_][A-Za-z0-9_]*)\s*::", text)
                if d:
                    defs.append((r, d.group(1)))
            srcs[path] = defs
        name = "?"
        for r, n in srcs[path]:
            if r <= line:
                name = n
            else:
                break
        out.write(f"{cname}\t{path}:{line}\t{name}\n")
        rows += 1
print("mapped", rows, "yo-origin definitions")
