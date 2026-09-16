# A two-line COMMENT change in `std/prelude.yo` makes `check ./std` fail

**Status:** OPEN. Found 2026-09-16 while updating a stale module doc comment.
Reproduces on the **v0.2.34 seed** and on a current tree build alike, so it
predates the change that found it.

## Symptom

Adding exactly **two** comment lines to `std/prelude.yo` — no code, no
declarations, only `//!` text — takes `check ./std` from 175/175 to **172/175**
with three bogus errors:

```
error[E0602]: Type Path does not implement required trait ToString.
    --> std/path.yo:176:65
    |
176 |   join : (fn(generic(P : Type), self : Self, other : P, where(P <: ToString)) -> Self)(
    |                                                                 ^^
error[E0602]: Failed to import module "./dir":
   --> std/fs/temp.yo:55:20
   --> std/fs/walker.yo:58:24
```

`Path` *does* implement `ToString`, and nothing about it was touched.

## The measurement — it is not monotone

Same base file, N plain filler comment lines appended to the module doc, on
both compilers:

| lines added | v0.2.34 seed | tree build |
| --- | --- | --- |
| +1 | 175/175 | 175/175 |
| **+2** | **172/175** | **172/175** |
| +3 | 175/175 | 175/175 |
| +4 | 175/175 | 175/175 |

So it is not a threshold and not parity — **only +2 fails**, and it fails
identically on both compilers. Content is irrelevant: two lines reading
`//! filler 0.` / `//! filler 1.` reproduce it exactly as a real rewrite does.
Re-running does not change the verdict; it is deterministic, not a flake.

## Why this is worse than it looks

Nothing warns. The author of a doc-comment edit has no reason to re-run
`check ./std`, and the failure names a file and a trait that have nothing to
do with the edit — so the natural reading is "`std/path.yo` is broken", which
sends the investigation to the wrong file. It was found here only because the
edit happened to sit in a branch whose `check ./std` had been green minutes
earlier with the same binary, which made the before/after unambiguous.

It also means **`check ./std` is sensitive to something that carries no
meaning** — a comment line count. Any such sensitivity is a correctness
hazard for every gate built on `check`.

## Reproducer

```bash
cd <worktree>
python3 - <<'PY'
import io
p = "std/prelude.yo"; s = io.open(p, encoding="utf-8").read()
a = "//! callers but changes where the methods are defined."
assert s.count(a) == 1
io.open(p, "w", encoding="utf-8").write(s.replace(a, a + "\n//! filler 0.\n//! filler 1."))
PY
yo check ./std   # 172/175, rc=1 — on the v0.2.34 seed
```

Remove one filler line, or add a third, and it is 175/175 again.

## Narrowed 2026-09-16 — it is the FIRST declaration, shifted by exactly two

Position matters, and the bisect is monotone. Inserting two plain `//` lines at
line N of `std/prelude.yo`, on a clean `develop` worktree with the seed:

| N | verdict |
| --- | --- |
| 2, 29, 42, 43 | **FAIL** 172/175 |
| 44, 45, 49, 56, 110, 219, 437, 873, 1745, 3488, 6975 | PASS 175/175 |

The boundary is exact. Line 44 is `Comptime :: trait(` — the FIRST declaration
in the prelude. Inserting *before* it fails; inserting one line later, inside
its body, passes. So the trigger is not the doc block, not the comment style
(plain `//` after the `//!` block fails identically), and not a total-count
effect: it is **`Comptime`'s own position, shifted by exactly two lines**.
Shift it by one, three or four and everything is green.

One specific declaration at one specific shift is the signature of a
COLLISION, not of an off-by-one.

## Where to look

Comment lines are not AST nodes, but they ARE tokens, so +2 comment lines
shifts every subsequent token index and every AST node id in the prelude by a
fixed amount. A defect keyed on a node id — a collision in a table shared
across modules, or an id reused where identity was assumed — would behave
exactly like this: invisible at almost every shift, wrong at one particular
one. `src/module_manager.yo`'s shared `ExprInfoTable` and the cached prelude
env are two places where prelude node ids outlive the prelude's own
evaluation.

**The stronger lead is TypeValue interning** (`src/types/intern.yo`), whose own
header documents this failure mode and a previous instance of it:

> CORRECTNESS: the key MUST NOT be coarser than codegen's type identity
> (`_type_key_at` / `g_struct_cfid_keys` / `g_enum_sig_keys`), else interning
> merges types codegen emits as distinct C types (the 2026-07-02 wrong-merge:
> `EnumT` keyed by id alone merged generic instantiations differing in
> `variant_fields` -> malformed C).

A wrong-merge is exactly what "`Path` does not implement `ToString`" looks like
from outside: the type reaching the bound check is not the `Path` the impl was
registered against. And the key is not purely structural — the cycle breaker
"renders id-only on re-encounter", so **type ids enter the key**, and ids come
from assignment order, which a declaration shift perturbs. That is a mechanism
for a collision that appears at one shift and vanishes at the next; a
content-only key could not produce one.

**The next experiment, and it costs one build:** unwrap the `intern_type` call
in `substitute` (`src/types/substitution.yo`) and re-run the +2 case. Green
means interning, and the work moves to the key; still red rules interning out
and sends this back to node ids. The gate for any fix here is the differential
corpus, NOT `check ./std` — `intern.yo`'s header says so twice, because `check`
skips codegen and this is a codegen-identity invariant.

The node-id-aliasing class already has precedent in this tree — a
single-expression begin block sharing its node id with its tail expr
(`issues/fixed/ref-local-scope-drop-missing-after-value-call.md`).

## Interaction with the value-substitution work

The branch that found this had to reword a `std/prelude.yo` module doc from 5
lines to 7 — exactly the failing delta. It is written at 8 lines instead. That
is a dodge, not a fix, and it is recorded here so the next person who finds a
prelude comment at an odd length knows why.
