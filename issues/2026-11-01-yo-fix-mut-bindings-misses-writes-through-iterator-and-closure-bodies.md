# `yo fix --migrate mut-bindings` misses writes through iterator and closure bodies

**Severity:** S3 — tooling: a declaration whose writes all sit inside a `for`
iterator body, a closure body, or a call of a `generic(...)`-first `&mut self`
method (the closure-body collection APIs) stays unmarked, so the decision 47
sweep leaves hand edits behind exactly where the B8–B11 flips concentrate them;
the migration reports success and nothing flags the gap.

**Status:** fixed 2026-11-02 (branch `fix/mut-bindings-iterator-closure-writes`,
for v0.2.74, before the B8–B11 flips). Found 2026-11-01 by three agents of the
v0.2.74 window front-load.

## Evidence (three independent agents, v0.2.74 window front-load)

1. **The B9–B11 census** (`~/Workspace/Yo-wt/vbd-logs/b9-b11-census/STATE.md`,
   taxonomy class 2, 2026-11-01): "writes through iterator/closure bodies
   (`out.try_insert(p.*)` inside `while`+`match`) are never marked — 4 hand edits in
   `hash_set.yo` alone (`union`/`intersection`/`difference`/`symmetric_difference`'s
   `mut(out)`)", plus `from_iter_add`'s `sink(acc)` parameter (rebind by hand), and 4
   hand `mut(out)` edits in `tests/collections/hash_set.test.yo`.
2. **The markdown-yo B8 companion**
   (`~/Workspace/Yo-wt/vbd-logs/mdyo-companion/STATE.md`, 2026-11-01): "43 non-mut
   `(name : ArrayList(T)) = ...` declarations that are then pushed/extended/resized/
   truncated. `yo fix --migrate mut-bindings` marks NOTHING here" across 16 files.
3. **The std half of decision 47 Generation B** (issue
   `issues/fixed/2026-10-25-migrate-mut-bindings-marks-only-the-bodies-its-run-evaluates.md`)
   closed the same class by hand (71 sites plus rebinds) — its §"How the std half
   closed it" step 6 is a lexical scan by hand, which is this issue's fix done
   manually.

All three ran the v0.2.73 seed, which predates #1691's lexical half entirely, so
their measurements show the pre-#1691 tool. Re-measured on the develop tip with
#1691 (2026-10-31), most of the catalogued surface regenerates: reverting every
hand `mut` edit of `b9-std-flip.patch` (11 markers: `hash_map.yo`'s
`mut(map)`/`mut(new_map)`/`mut(result)`/`mut(out) := acc`, `hash_set.yo`'s four
`mut(out)` + `mut(me)`, `html_entities`' two typed declarations, `walker`'s
`mut(followed)`) and running one migration over the four files restored all 11
byte-for-byte; `b9-tests-mut.patch`'s 159 test markers are all reproduced (as a
superset); `b11-std-flip.patch`'s 6 std markers (`fmt/format`, `fmt/spec`,
`net/addr`, `url/index` StringBuilder writers) restore byte-for-byte.

## The shape that still failed on the develop tip

The write goes through a `&mut self` method whose `fn` head carries a LEADING
`generic(...)` (or trailing `where(...)`) — every closure-body collection API:

```yo
{ HashMap } :: import("std/collections/hash_map.yo");

test("entry.or_insert inserts only when vacant", {
  m := HashMap(i32, i32).new();
  assert(m.entry(i32(1), e => e.or_insert(i32(10))) == i32(10), "vacant inserts");
  assert(m.len() == usize(1), "and grew the map");
});
```

`entry : (fn(generic(R : Type), self : &mut Self, key : &K, sink(body) : Impl(FnOnce(e : &mut HashMapEntry(K, V)) -> R), where(K <: Clone)) -> R)`
— the receiver is the head's SECOND parameter. `yo fix --migrate mut-bindings`
marked 0 here (measured against the B9-flipped std with the develop-tip binary);
`YO_DEBUG_FIX_LEXICAL_ONLY=1` over `tests/collections/hash_map.test.yo` listed
the same `m` sites as "the walk missed". In std the shape is `HashMap.entry`,
`ArrayList.with` and `Deque.with` (`fn(generic(R : Type), self : &mut Self,
index : usize, sink(body) : ...)`); wherever evaluation does not reach the call
(a deferred test body, a generic trial that stopped earlier, an unlisted
dependency), the declaration stays unmarked and post-flip code fails with E0917.

## Root cause

The lexical half's method table is collected by `_mbl_note_member`
(`src/main.yo`), which took the head's FIRST parameter as the receiver. A head
with a leading `generic(R : Type)` therefore never matched `self`, so
`HashMap.entry`/`ArrayList.with`/`Deque.with` were absent from `any_mut` —
a call `m.entry(k, body)` was not counted as a write of `m`, and
`_mbl_place_root` did not even recognise `x.with(...)` as a method call.

## Fix

`_mbl_note_member` now skips `generic(...)` and `where(...)` head entries (they
bind no runtime value; `_mbl_bind_param` already treats them that way) before
locating `self`, so the receiver is the first VALUE parameter. Measured against
the B9-flipped std: the `entry` fixture above goes from 0 marks to `mut(m)`,
and `YO_DEBUG_FIX_LEXICAL_ONLY=1` over `hash_map.test.yo` reports no walk
misses. On today's (pre-flip) std nothing changes: a `ref` collection's recorded
`MUT_FACET_BORROW` still declines the write, and a declaration no evaluation
reached gains at most a spare `mut` — the trade #1691 already documented ("a
spare `mut` is harmless ... they become required when B8–B11 make the
collections values").

## Regression test

`tests/cli-cases/fix-migrate-mut-bindings-generic-first-mut-self-methods`: a
self-contained fixture (no std flip needed) whose generic body writes a local
only through a `generic(R : Type), self : &mut Self` method, `fix lib.yo
--migrate mut-bindings --dry-run` whose count includes the binding, and a
trailing `check use.yo`. Fails before the fix (0 marks), passes after.
