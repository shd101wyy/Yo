"""Per-site / per-function call-count profiler for the emitted C.

Finds WHERE allocations and hot calls come from, which a per-constructor
census (`instrument_ctors.py`) cannot answer. Two instrumentations:

1.  every named `fn_yo<mod>_id_<n>_<name>(...) {` definition gets an entry
    counter -> a full call-count profile of the self-hosted compiler;
2.  every textual CALL of a chosen constructor or function is rewritten to
    `(__yo_prof_n[K]++, name)(...)` -> per-CALL-SITE counts, each mapped back
    to its line and enclosing (named) function.

Usage:
    python3 scripts/bootstrap/instrument_calls.py \
        --src /tmp/re/s1.c --out /tmp/re/s1prof.c --map /tmp/re/prof_map.txt \
        --counts /tmp/re/prof_counts.txt \
        --ctor 'ArrayList(u8)' --ctor Variable --fn add_variable_to_env

    clang -std=c11 -fno-strict-aliasing -fwrapv -w -O2 /tmp/re/s1prof.c -o /tmp/re/s1prof
    <binary> compile src/main.yo --optimize 2 --emit-c --skip-c-compiler -o /tmp/x
    python3 scripts/bootstrap/report_calls.py            # joins counts + map

`--ctor NAME` matches the Yo type name in the struct's trailing comment, so it
survives the per-build renumbering of `_id_<n>`. `--fn NAME` matches the Yo
function name suffix of the mangled C name (named module-level functions keep
their name in the emitted C; anonymous closures do not).
"""

import argparse
import re
import sys


def resolve_ctor(src, yo_type):
    """Yo type name -> its `__yo_new_...` constructor function name(s)."""
    out = []
    for m in re.finditer(
        r"struct (__yo_(?:struct|enum)_yo\w+_id_\d+)_struct \{ // ([^:\n]{0,300}?) :", src
    ):
        if m.group(2).strip() == yo_type:
            base = m.group(1)
            for mm in re.finditer(
                r"\b(__yo_new_" + re.escape(base) + r"(?:_\w+)?)\(", src
            ):
                if mm.group(1) not in out:
                    out.append(mm.group(1))
    return out


def resolve_fn(src, yo_name):
    """Yo function name -> mangled C name(s) ending in that name."""
    pat = re.compile(r"\b(fn_yo[a-f0-9]+_id_\d+_" + re.escape(yo_name) + r")\(")
    return sorted({m.group(1) for m in pat.finditer(src)})


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", default="/tmp/re/s1.c")
    ap.add_argument("--out", default="/tmp/re/s1prof.c")
    ap.add_argument("--map", default="/tmp/re/prof_map.txt")
    ap.add_argument("--counts", default="/tmp/re/prof_counts.txt")
    ap.add_argument("--ctor", action="append", default=[],
                    help="Yo type name whose constructor call sites to count")
    ap.add_argument("--fn", action="append", default=[],
                    help="Yo function name whose call sites to count")
    ap.add_argument("--no-fn-entries", action="store_true",
                    help="skip the whole-program function entry counters")
    args = ap.parse_args()

    src = open(args.src).read()
    labels = []

    # ---------- 1. function entry counters ----------
    nfn = 0
    if not args.no_fn_entries:
        fndef = re.compile(
            r"^((?:__attribute__\(\([^)]*\)\)\s*)?static\s[^;{}]*?"
            r"\b(fn_yo[a-f0-9]+_id_\d+_[a-z_][a-z_0-9]*)\([^;{}]*\)\s*\{)",
            re.M,
        )

        def fn_repl(m):
            labels.append("FN:" + m.group(2))
            return m.group(1) + "\n  __yo_prof_n[%d]++;" % (len(labels) - 1)

        src, nfn = fndef.subn(fn_repl, src)

    # ---------- 2. per-call-site counters ----------
    targets = {}
    for t in args.ctor:
        names = resolve_ctor(src, t)
        if not names:
            print("warning: no constructor found for type %r" % t, file=sys.stderr)
        for n in names:
            targets[n] = "CTOR:" + t
    for f in args.fn:
        names = resolve_fn(src, f)
        if not names:
            print("warning: no function found named %r" % f, file=sys.stderr)
        for n in names:
            targets[n] = "CALL:" + f

    nsite = 0
    if targets:
        lines = src.split("\n")
        starts = [0]
        for i, ch in enumerate(src):
            if ch == "\n":
                starts.append(i + 1)

        def line_of(off):
            lo, hi = 0, len(starts) - 1
            while lo < hi:
                mid = (lo + hi + 1) // 2
                if starts[mid] <= off:
                    lo = mid
                else:
                    hi = mid - 1
            return lo + 1

        pattern = re.compile(r"\b(" + "|".join(re.escape(k) for k in targets) + r")\(")
        pieces, pos = [], 0
        for m in pattern.finditer(src):
            name, start = m.group(1), m.start()
            # the definition (or forward declaration) itself: the call name is
            # preceded on ITS OWN LINE only by a `static ...` return type
            line_start = src.rfind("\n", 0, start) + 1
            prefix = src[line_start:start]
            if re.match(r"^\s*(?:__attribute__\(\([^)]*\)\)\s*)?static\s[\w*\s]*$", prefix):
                continue
            ln = line_of(start)
            encl = "?"
            for j in range(ln - 1, max(0, ln - 6000), -1):
                mm = re.search(
                    r"\b(fn_yo[a-f0-9]+_id_\d+_[a-z_][a-z_0-9]*)\([^;]*\)\s*\{\s*$",
                    lines[j],
                )
                if mm:
                    encl = mm.group(1)
                    break
            labels.append("%s@%s:L%d" % (targets[name], encl, ln))
            pieces.append(src[pos:start])
            pieces.append("(__yo_prof_n[%d]++, %s)(" % (len(labels) - 1, name))
            pos = m.end()
            nsite += 1
        pieces.append(src[pos:])
        src = "".join(pieces)

    n = len(labels)
    if n == 0:
        print("nothing instrumented", file=sys.stderr)
        return 1
    prelude = (
        "\n#include <stdio.h>\n"
        "static unsigned long long __yo_prof_n[%d];\n"
        "__attribute__((destructor)) static void __yo_prof_dump(void) {\n"
        '  FILE* f = fopen("%s", "w");\n'
        "  if (!f) return;\n"
        "  for (int i = 0; i < %d; i++) if (__yo_prof_n[i]) "
        'fprintf(f, "%%llu %%d\\n", __yo_prof_n[i], i);\n'
        "  fclose(f);\n"
        "}\n"
    ) % (n, args.counts, n)

    first = src.find("__yo_prof_n[")
    ins = src.rfind("\n\n", 0, first)
    if ins < 0:
        ins = src.rfind("\n", 0, first)
    src = src[:ins] + prelude + src[ins:]
    open(args.out, "w").write(src)
    with open(args.map, "w") as f:
        for i, lab in enumerate(labels):
            f.write("%d\t%s\n" % (i, lab))
    print("functions: %d  call sites: %d  counters: %d" % (nfn, nsite, n))
    return 0


if __name__ == "__main__":
    sys.exit(main())
