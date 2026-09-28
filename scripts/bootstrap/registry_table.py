"""The registry sweep table: every module-level global of the compiler, with
its size at exit and how (whether) anything ever empties it.

plans/EVALUATOR_MEMORY_REDUCTION.md Phase 1 step 5. Inputs:
  - the compiler source (`src/**.yo`): every top-level `(name : Type) = ...`
    declaration;
  - a holder-census dump (holder_census_t.py, HOLDER_SCAN=1 HOLDER_DEEP=1):
    `L <length> <root>` (container length at exit) and `D <objects> <bytes>
    <root> <type>` (bytes first reached from that root).

For each global, the table reports which functions write-remove it
(`.remove(`, `.clear(`, `= <Type>.new()` re-assignments) outside its own
initializer, and whether one of them is reached from `mm_invalidate_document`
(the LSP / watch purge) — read as "purged per module". The class column is a
HEURISTIC first cut, to be corrected by hand for the rows that matter:
  process     — never emptied; lives as long as the compiler
  per-module  — emptied by the owner purge (`mm_invalidate_document`)
  per-command — reset by a command-level reset/clear function
  scalar      — not a container (a flag, a counter, a handle)

Usage:
  python3 scripts/bootstrap/registry_table.py <src-dir> <holders_dump.txt> [--markdown]
"""
import collections, os, re, sys

src_dir, dump = sys.argv[1], sys.argv[2]
markdown = "--markdown" in sys.argv

decl_re = re.compile(r"^\((\w+) : ([^)=]+(?:\([^=]*\))?)\) = ", re.M)
decls = {}   # name -> (file, line, type)
bodies = {}  # file -> text
for root, _, files in os.walk(src_dir):
    for f in files:
        if not f.endswith(".yo"):
            continue
        p = os.path.join(root, f)
        t = open(p, errors="replace").read()
        bodies[p] = t
        for m in decl_re.finditer(t):
            name, ty = m.group(1), m.group(2).strip()
            line = t.count("\n", 0, m.start()) + 1
            decls.setdefault(name, (os.path.relpath(p, src_dir), line, ty))

# Census rows are keyed by `<name>_m<hash>`.
length = {}
bytes_ = collections.Counter()
objs = collections.Counter()
for l in open(dump, errors="replace"):
    f = l.split()
    if not f:
        continue
    if f[0] == "L" and len(f) >= 3:
        length[re.sub(r"_m\d+$", "", f[2])] = int(f[1])
    elif f[0] == "D" and len(f) >= 4:
        r = re.sub(r"_m\d+$", "", f[3])
        bytes_[r] += int(f[2])
        objs[r] += int(f[1])

# Functions (top-level `name :: (fn...`) and their bodies, to see who empties what.
fn_re = re.compile(r"^(\w+) :: \(\s*fn\b", re.M)
fn_spans = []  # (file, name, start, end)
for p, t in bodies.items():
    starts = [(m.start(), m.group(1)) for m in fn_re.finditer(t)]
    for i, (s0, n) in enumerate(starts):
        e0 = starts[i + 1][0] if i + 1 < len(starts) else len(t)
        fn_spans.append((p, n, s0, e0))

def emptiers(name):
    out = set()
    pat = re.compile(r"\b%s\s*(?:\.\s*(?:remove|clear|truncate)\s*\(|=\s*\w[\w()., ]*\.new\(\))" % re.escape(name))
    for p, n, s0, e0 in fn_spans:
        if pat.search(bodies[p], s0, e0):
            out.add(n)
    return out

# Functions reachable from mm_invalidate_document (the LSP / watch purge),
# transitively: `purge_expr_side_tables` reaches `_purge_expr_side_tables_at`.
calls = collections.defaultdict(set)
for p, n, s0, e0 in fn_spans:
    calls[n] |= set(re.findall(r"\b(\w+)\(", bodies[p][s0:e0]))
purge_called = set()
todo = ["mm_invalidate_document"]
while todo:
    n = todo.pop()
    for c in calls.get(n, ()):
        if c not in purge_called:
            purge_called.add(c)
            todo.append(c)

rows = []
for name, (f, line, ty) in decls.items():
    is_container = bool(re.match(r"(HashMap|ArrayList|HashSet|OwnedKeys)\b", ty))
    em = emptiers(name)
    if not is_container:
        cls = "scalar"
    elif em & purge_called:
        cls = "per-module"
    elif any(re.search(r"reset|clear|begin|end_|purge|take_", e) for e in em):
        cls = "per-command"
    else:
        cls = "process"
    rows.append((bytes_[name], name, f, line, ty, length.get(name), cls, sorted(em)))

rows.sort(key=lambda r: (-r[0], r[1]))
if markdown:
    print("| global | module | type | length at exit | first-reach MB | class | emptied by |")
    print("| --- | --- | --- | --- | --- | --- | --- |")
for b, name, f, line, ty, ln, cls, em in rows:
    ty_s = (ty[:48] + "…") if len(ty) > 49 else ty
    em_s = ", ".join(em[:3]) + (" …" if len(em) > 3 else "")
    if markdown:
        print(f"| `{name}` | `{f}:{line}` | `{ty_s}` | {'' if ln is None else f'{ln:,}'} | {b/1048576:.1f} | {cls} | {em_s} |")
    else:
        print(f"{b/1048576:8.1f} MB  {'' if ln is None else ln:>9}  {cls:<11} {name:<40} {f}:{line}  {ty_s}  [{em_s}]")
counts = collections.Counter(r[6] for r in rows)
print(("\n" if markdown else "") + "totals: " + ", ".join(f"{k} {v}" for k, v in sorted(counts.items())), file=sys.stderr)
