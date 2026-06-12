# Flowability soundness v4 — delete interior refs

Status: **✅ IMPLEMENTED** (2026-06-12). Phase 1 (std deletions:
ea78b3c5d), Phase 2 (test migration: c3581e8eb), Phase 3 (ref-return
ban, both compilers: 163e46565), Phase 4 (owner pin + call-site ref/own
exclusivity gate: c4fc74ee3), Phase 5 (docs/knowledge files). Two
additions beyond the original plan: the `ref(r) := x` bare-local borrow
codegen (`(&(x))`; previously only reachable via banned ref-returning
calls) and the **call-site ref/own exclusivity gate**
(`requireRefOwnArgumentExclusivity`) which closes the argument-position
shape `f(h.s, h)` with `own` — the binding-site pin cannot see it. The
yo-self mirror of that gate is blocked on the documented own/consume
port gap (see `plans/BOOTSTRAPPING_CODEGEN.md` Phase 4).
Supersedes v3 (declared `mut` + exclusivity law), v2 (inferred
summaries), v1 (dynamic borrow counter) — appendix has the history.
Companion: `issues/fixed/flowability-growth-invalidation-method-calls.md`
(closed by this design) and the landed same-scope gates (8b0b67b1).

**Owner constraints:** maximize static checking; no meaningful runtime
overhead (perf target 0–15% of C); keep the language simple and
LLM-friendly. **v4 is the simplicity-first answer**: instead of building
machinery to police pointers into reallocatable storage (v1–v3), remove
the one feature that creates them.

## The decision

The unsoundness family (growth invalidation, cross-function aliasing,
heap-mediated handles) requires three ingredients: interior pointers
into reallocatable storage + freely aliasable container handles + alias-
invisible function boundaries. v1–v3 attacked the third ingredient with
ever-growing machinery. v4 removes the FIRST: `project`-style interior
refs are deleted, and `ref` return types are banned outright.

Empirical basis (2026-06-12, M-series Mac, `--release` -O2, 100M element
accesses, 1000-element lists, benchmark source preserved below):

| variant                         | per access | delta                                                                  |
| ------------------------------- | ---------- | ---------------------------------------------------------------------- |
| `ArrayList(String)` via project | ~6.9 ns    | baseline                                                               |
| `ArrayList(String)` via get     | ~7.6 ns    | +10% (worst case: empty loop body; RC dup+drop ≈ 0.7 ns)               |
| `ArrayList(Big64B)` via project | ~0.38 ns   | baseline                                                               |
| `ArrayList(Big64B)` via get     | ~0.27 ns   | **−29% — the copy is FASTER** (vectorizes; ref indirection pessimizes) |

And the decisive structural fact: **yo-self — the largest Yo program in
existence — contains ZERO uses of `.project(` and ZERO uses of the
for-macro borrow form.** The entire self-hosted compiler never needed
interior refs. This also aligns with the slice rework, which already
deleted `Slice(T)` and made ranges copying; `project` was the last
interior-pointer feature standing, and every UAF since has come from it.

## What goes, what stays

| REMOVED                                                            | KEPT                                                                                     |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| `Indexable` trait + all `project` impls                            | `ref(x) : T` PARAMETERS (write-back, big-struct no-copy)                                 |
| `ref` in RETURN-TYPE position (new evaluator gate)                 | `ref(r) := lvalue` local borrows of locals & object FIELDS                               |
| for-macro borrow form `for(coll, ref(x) => …)`                     | callback-style ref params (`Mutex.with_lock`)                                            |
| flowability return-root rules (now dead code)                      | the same-scope borrow-invalidation gates (free, good diagnostics)                        |
| ALL of v3 (`mut`, exclusivity law, deep immutability, fresh roots) | raw-pointer `Index` impl (`-> *(T)`) as the explicit `unsafe` escape hatch for hot loops |

Element access model after v4 (the Java/Python model — zero new
concepts):

```rust
e := xs.get(i);          // object elements: dup'd HANDLE to the element
e.push_str("!");         //   → mutates the element in place; no borrow needed;
                         //   the handle survives xs.push/realloc (it points at
                         //   the String object, not into xs's buffer)
t := xs.get(i);          // struct elements: copy out …
xs.set(i, t2);           //   … write back
for(xs, (x) => …);       // value-form iteration (already get-based today)
```

## Why this is sound BY CONSTRUCTION

After v4, every live `ref` roots in exactly one of:

1. **A caller's frame slot** (ref params, `ref(r) := local`) — frames
   outlive callees by construction; refs are second-class (cannot be
   returned or stored), so they never outlive the frame below them.
2. **A field of an RC object** (`ref(r) := h.s`) — object allocations
   never move/realloc, and codegen PINS the owner (one RC dup at the
   binding, one drop at the ref's scope end, riding the existing
   deferred-cleanup lists) so the object cannot be freed while borrowed
   — even by cross-function `own`/drop paths the static gates can't see
   (`f(h.s, h)` with `own(h)`). Cost: 2 refcount ops per BINDING (not
   per access) — nanoseconds, and only on field borrows.

No pointer into reallocatable storage can exist anywhere in the safe
language; growth invalidation is not "checked", it is INEXPRESSIBLE.
The same-scope gates remain purely as high-quality early diagnostics
(reassign/move-while-borrowed is still a compile error, not a silent
pin). The cross-function aliasing residual of the gates becomes moot:
mutating an aliased container while holding `get` handles is safe,
because handles don't point into buffers.

Callback-style APIs cannot smuggle interior refs back in, either. A
`with`-style method (`xs.with(i, (ref(e) : T) => …)`) would have to
MANUFACTURE a `ref` into its own heap buffer to feed the callback — and
no safe expression does that: the safe sources of `ref` are exhaustively
locals, object fields, and `ref` parameters (inductively the same set),
and the raw `Index` pointer converts only under `unsafe(...)`. So the
classic counterexample (callback captures `xs`, pushes during the
borrow, reads `e` → UAF) is unwritable in safe code. `Mutex.with_lock`
remains safe and legal: its `ref(v)` roots at an object FIELD (stable
address, pinned owner), not in a growable buffer. The safe replacement
for `with` needs no callback at all: `e := xs.get(i)` → `xs.push(…)` →
use `e` — the handle points at the element object, which realloc does
not move.

`unsafe` remains outside this story by definition: the raw `Index` impl
(`index : … -> *(T)`) is the documented escape hatch when a hot loop
measurably needs zero-copy struct-element access.

## Implementation plan

Written for an implementing agent. Follow `AGENTS.md` +
`.github/instructions/` (`yo-syntax`, `testing`). Standing rules: mirror
every TS evaluator change 1:1 in yo-self; `./yo-cli fmt` every touched
`.yo` file; commit per phase (`--no-verify`, trailer
`Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`), push, keep CI
green.

### Canonical validation gates

```bash
# G1 — TS build + evaluator unit tests (457 expected)
bun run build && bun test src/tests/fixme.test.ts --timeout 10000
# G2 — evaluator-only checks
./yo-cli check ./std && ./yo-cli check ./tests
# G3 — targeted codegen tests (--parallel 1 for single files)
./yo-cli test ./tests/ref_binding.test.yo --bail -v --parallel 1
./yo-cli test ./tests/ref_borrow_invalidation.test.yo --bail -v --parallel 1
./yo-cli test ./tests/ref_field_borrow.test.yo --bail -v --parallel 1
./yo-cli test ./tests/for_macro_borrow.test.yo --bail -v --parallel 1
./yo-cli test ./tests/collections/ --bail -v --parallel 1
# G4 — yo-self build + sweeps (~12-15 min; NO --release; classify by exit code)
./yo-cli compile yo-self/main.yo -o /tmp/yo-self-bin &> /tmp/yoself_build.log
YO_MAIN_STACK_MB=4096 /tmp/yo-self-bin check ./std     # 152/152
YO_MAIN_STACK_MB=4096 /tmp/yo-self-bin check ./tests   # 143/145 (circular_error_{a,b} = baseline)
YO_MAIN_STACK_MB=4096 /tmp/yo-self-bin check ./yo-self # 237/237
# G5 — full integration suite (~30 min; at milestones)
./yo-cli test --bail
```

### Phase 1 — std: remove the borrow form and `project`

Exact surface (verified by grep 2026-06-12 — the complete list):

1. `std/prelude.yo` — `Indexable` trait declaration (~line 244–260);
   `Array` project impl (~5586–5600); the for-macro ref arm
   (~7729–7772). Replace the ref arm's expansion with a
   `comptime_assert(false, …)` carrying the migration message:
   `'for(coll, ref(x) => …)' was removed — use the value form
'for(coll, (x) => …)'; object elements mutate in place through the
handle; for struct elements use an index loop with get/set`. (A
   teaching error beats silent removal; LLMs self-correct from it.)
2. `std/collections/array_list.yo` — project impl (546–567); the
   `_ArrayListPosIter` position iterator + `iter()` (~625+) IF its only
   consumer was the ref form (verify by grep; the value form uses
   `into_iter`). Keep the raw-pointer `Index` impl (532–544) — it is the
   unsafe escape hatch.
3. `std/string/string.yo` — byte project impl (~2333–2345) and the
   byte-position iterator wiring (~1690–1735). Ensure a value-form byte
   iteration path exists (`s.bytes()`-style iterator yielding `u8` by
   value, or an `into_iter`); migrate doc comments.
4. `std/collections/hash_map.yo` — bucket project impl (~748) + the
   position-iterator override (~733, ~761). Provide value-form bucket
   iteration (`into_iter` yielding buckets; `Bucket(K,V)` handles/copies
   per its type kind).
5. `std/encoding/json.yo:176–202` — already-`unsafe` raw-pointer uses of
   project; switch to the raw `Index` impl inside the same `unsafe(...)`
   blocks.

Gate: G1 + G2-std + G3 collections + a smoke `./yo-cli test ./tests
--bail` (expect the to-be-migrated test files to fail — that's Phase 2's
worklist; use the failure list, don't pre-guess). Commit.

### Phase 2 — tests migration

- `tests/indexable.test.yo`, `tests/indexable_runtime.test.yo` — the
  feature is gone: delete, replacing with `tests/ref_return_ban.test.yo`
  in Phase 3.
- `tests/for_macro_borrow.test.yo` — rewrite as value-form semantics
  tests (object elements mutate through handles; struct elements via
  index + get/set), keeping the file as the for-macro's coverage.
- ref-form loop users: `tests/array.test.yo`,
  `tests/privilege_pragma.test.yo`, `tests/closure_capture_rc_leak.test.yo`,
  `tests/collections/hash_map.test.yo`,
  `tests/collections/array_list.test.yo` — convert each loop to the
  value form (object elements behave identically through handles).
- `tests/ref_binding.test.yo`, `tests/ref_borrow_invalidation.test.yo` —
  project-based borrows must become field/local borrows (`ref(r) :=
h.s`); the GATES under test remain. Cases that specifically tested
  "borrow from container then grow" become unrepresentable — convert the
  best of them into positive tests (get-handle survives `xs.push`,
  asserted by value).

Gate: G2 + G3 + G5. Commit.

### Phase 3 — evaluator: ban `ref` in return-type position

- TS: in `src/evaluator/types/function.ts`, where the return type is
  evaluated, reject a `ref(...)`-wrapped return type for functions,
  closures, and trait-method signatures alike. Error text: `functions
cannot return 'ref' — return the value (object elements are handles;
struct elements copy), or take a callback parameter that receives
'ref(x) : T'`. (Must not reference plans/\*.md paths.)
- yo-self mirror: `yo-self/evaluator/types/function.yo`, same placement
  and text.
- Delete the now-dead flowability return-root machinery: the
  return-position rules in `src/evaluator/types/flowability.ts` (R1–R4
  return admission, the `isParameter` slice-return admission noted on
  `Variable.isParameter`) and their yo-self mirrors in
  `yo-self/types/flowability.yo`. KEEP: `findLiveBorrowerOfVariable`,
  `requireNotLiveBorrowSourceForCall`, `aliasGroupRoot`,
  `collectAliasGroup` and every landed gate. Delete only what the ban
  makes unreachable — verify by coverage of G1/G2, not by guesswork.
- Tests: `tests/ref_return_ban.test.yo` with `comptime_expect_error`
  for: fn returning `ref(T)`; trait method declaring `-> ref(T)`;
  closure type `fn(...) -> ref(T)`. Positive: callback-style
  `with`-pattern (param `body : Impl(Fn(ref(v) : T) -> R)`) still works
  (`std/sync/mutex.yo` is the live precedent).

Gate: G1–G4. Commit.

### Phase 4 — codegen: pin the owner of field borrows

In `src/codegen/exprs/initialization-assignment.ts`, the ref-binding
lvalue path (the `(&(${lvalueCode}))` emission added for ref-to-field):
when the borrowed lvalue roots in an RC OBJECT (not a value-struct
local), emit a `___dup` of the owner at the binding and register the
matching drop on the binding scope's deferred-cleanup list (the same
lists scope-end drops and early-return cleanups already use — precedent:
commit 8b0b67b1's hardening). Value-struct locals and ref params get no
pin (frame-stable). Add a runtime test to
`tests/ref_field_borrow.test.yo`: pass `h.s` as a `ref` param together
with `own(h)` (or drop `h`'s last visible handle inside the callee) and
assert the read through the ref is still valid — this is the
cross-function residual that static gates cannot see, now closed by the
pin. Run it under gmalloc
(`DYLD_INSERT_LIBRARIES=/usr/lib/libgmalloc.dylib`) locally and rely on
Linux ASan in CI.

Gate: G1–G3 + G5. Commit. (Codegen is TS-only today; add `ref`-return
ban + owner-pin semantics to `plans/BOOTSTRAPPING_CODEGEN.md`'s spec so
the future codegen port carries them.)

### Phase 5 — docs + knowledge files

Both `docs/en-US/` and `docs/zh-CN/`; ```rust fences for Yo code:

1. `FLOWABILITY.md` — major SIMPLIFICATION: refs are parameters +
   local/field borrows; no ref returns; the soundness-by-construction
   argument; the get/set element model; the `unsafe` Index escape hatch;
   the same-scope gates as diagnostics.
2. `MEMORY_SAFETY.md` — update the story: interior pointers are
   inexpressible; field borrows pinned.
3. `GRAMMAR.md` — document the parameter modifiers (`ref`/`inout`,
   `own`) and the `ref` placement rules (currently undocumented).
4. `.github/instructions/yo-syntax.instructions.md` + the
   `.github/skills/` cheatsheets — get/set model, "no ref returns", the
   for-macro value form, the removal error message.
5. Mark `plans/ITERATOR_REDESIGN.md`'s borrow form as superseded by this
   file. Update `issues/flowability-growth-invalidation-method-calls.md`
   → resolved, move to `issues/fixed/`.

Gate: G1–G2 + final G5 + CI green. Commit + push.

### Non-goals (decisions that stand from v3's analysis)

- No `mut` modifier — for parameters OR locals — is REQUIRED for
  soundness anymore. `mut` parameters remain a possible FUTURE opt-in
  for API documentation and a parallelism story, decoupled from memory
  safety; do not implement as part of v4.
- No `let`/`var` binding keywords; locals stay mutable. The language
  rule: _mutability is free; aliasing is safe; interior pointers don't
  exist._
- No runtime exclusivity checks; the only runtime artifact of v4 is the
  per-binding owner pin (2 refcount ops), which is a lifetime guarantee,
  not a check.

## Benchmark source (reproduce before changing course)

`src/tests/fixme.yo` as of 2026-06-12 (scratch file): builds
`ArrayList(String)` (19-byte strings) and `ArrayList(Big)` (8×i64
struct), 1000 elements, 100k passes, summing `len()` / `.a` via
`project` vs `get`; compile `./yo-cli compile src/tests/fixme.yo
--release -o /tmp/bench && /tmp/bench`. Numbers in the table above were
stable across 3 runs (±2%).

## Appendix — design history

- **v1**: Swift-style dynamic Law of Exclusivity (borrow counter in the
  RC header, asserts in mutating methods, panic on violation). Rejected:
  runtime checks. (Full text: git history, commit e7507f7c.)
- **v2**: inferred per-function MUTATES/BORROWS/ESCAPES summaries +
  call-site overlap law with obligation propagation. Rejected: effects
  invisible in signatures, non-local errors, pessimism at
  recursion/dyn/extern. (Commit e7507f7c.)
- **v3**: declared `mut` parameters (immutable-by-default), deep
  transitive immutability with derived-handle tracking, returns-fresh
  chain-breaking, fresh-allocation roots, purely-local call-site
  exclusivity law, 9-phase migration. SOUND and zero-overhead, but the
  complexity kept compounding (deep immutability, derived handles,
  returns-fresh, variance) — all of it servicing ONE feature
  (`project`) that benchmarks showed is worth ≤10% in the worst case,
  is FASTER to replace for struct elements, and that the largest Yo
  program never uses. (Full text: git history, commit 17f3e745.)
- **v4** (this document): delete the feature instead of policing it.
