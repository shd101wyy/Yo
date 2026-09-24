"""Map emitted-C function ids (`yo_id_<hash><6-digit occurrence>`) back to Yo names.

`stable_func_id` (src/utils.yo) mints a fid as
fnv1a64("<prefix>:<module_path>:<row>:<col>") + a 6-digit occurrence, where
module_path is the demand-loader spelling `file://<abs path>` and row/col are
the 0-based position of the fn type's `->` token. This rehashes every `->` in
src/ and std/ and keeps the hashes that occur in the given C file.

Usage (from the checkout that produced the C):
  python3 scripts/bootstrap/fid_name_map.py fresh.c fidmap.tsv
Output rows: `yo_id_<digits>\t<file>:<line>\t<nearest preceding name ::>`.
Coverage on the 2026-09-24 self-emit: 4,478 of 5,446 fids (the rest are
generated/derived functions with other prefixes or synthetic positions).
"""
import glob, os, re, sys

c_path, out_path = sys.argv[1], sys.argv[2]
c = open(c_path).read()
by_hash = {}
for f in set(re.findall(r"yo_id_(\d+)", c)):
    if len(f) > 6:
        by_hash.setdefault(f[:-6], []).append(f)

def fnv(s):
    h = 14695981039346656037
    for b in s.encode():
        h = ((h ^ b) * 1099511628211) & 0xFFFFFFFFFFFFFFFF
    return str(h)

hits = 0
with open(out_path, "w") as out:
    for fn in glob.glob("src/**/*.yo", recursive=True) + glob.glob("std/**/*.yo", recursive=True):
        key_path = "file://" + os.path.abspath(fn)
        last_def = "?"
        for r, line in enumerate(open(fn).read().split("\n")):
            m = re.match(r"\s*([A-Za-z_][A-Za-z0-9_]*)\s*::", line)
            if m:
                last_def = m.group(1)
            for mm in re.finditer(r"->", line):
                for pre in ("", "fn_", "closure_"):
                    for f in by_hash.get(fnv(f"{pre}:{key_path}:{r}:{mm.start()}"), []):
                        out.write(f"yo_id_{f}\t{fn}:{r + 1}\t{last_def}\n")
                        hits += 1
print("mapped", hits, "of", sum(len(v) for v in by_hash.values()))
