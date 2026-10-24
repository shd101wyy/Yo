# A callee that writes a scalar global is assumed to mutate every argument

**Severity:** S2 — a valid program panics. A read-only `self : &Self` method
that passes `&self.name` to a function which only bumps a module-level `i32`
counter gets the borrowed `for`'s entry invalidation assert. Called through a
second handle inside `for(&mut bag, …)`, it panics with "container operation
while an interior reference … borrows from it".

**Status:** fixed 2026-10-24 on `fix/scalar-global-mask` (see "Fix" below).
**Found:** 2026-10-24 by the review of
`issues/fixed/2026-10-23-a-read-only-method-iterating-a-value-field-asserts-its-receiver-unborrowed.md`.
The v0.2.68 seed, develop `f271ed005` and that fix all panic on the plain
spelling below. The fix adds the constructor-argument spelling: before it,
a call inside a constructor argument was skipped by the analysis (the S1
`issues/fixed/2026-10-23-a-mutating-call-inside-a-constructor-argument-escapes-the-borrow-assert.md`),
which hid this false positive there. Develop ran `label_ctor` with rc 0;
the fix panics on it, the same as `label_plain` on every binary.

## Reproducer

`issues/repros/2026-10-24-a-callee-that-writes-a-scalar-global-is-assumed-to-mutate-every-argument.yo`:

- `count_copy(s : &String) -> String` runs `g_n = (g_n + i32(1))` on a
  module-level `i32` and returns `s.clone()`.
- `Bag.label_ctor(self : &Self)` calls it inside a constructor argument,
  `W3(s : count_copy(&self.name), n : usize(1))`; `Bag.label_plain` binds
  `s := count_copy(&self.name)`.
- `main` calls both through `other := bag` inside
  `for(&mut bag, x => { …; x = (x + i32(1)) })`.

Expected: prints `4` twice, rc 0. Actual (`--sanitize address --allocator
system`, seed, develop and the fix): the panic above, rc 134.

A callee that only logs (`println(s)`) or only clones (`s.clone()`,
`to_string`) is not affected.

## Root cause

Two conservative rules in `src/evaluator/effects/mutation_summary.yo` combine:

1. `_MsP.walk`'s assignment arm sets `m.all = true` for any store to a
   variable with `is_module_level` (`YO_DEBUG_BORROW_MASK=1` prints
   `[borrow-all] walk: g_n = (g_n + i32(1))`). The rule does not look at the
   global's type, so an `i32` global, which holds no RC handle and no pointer
   and cannot reach any container's storage, counts the same as a global
   `ArrayList`.
2. At a call to a callee whose mask is `all`, the walk attributes a deep
   mutation to every rooted argument (`_msp_mask_add_root`), including a
   shared `&String` argument. `label_*` therefore gets `self` in its mask and
   the `__yo_borrow_assert_unborrowed(self)` entry assert.

Rule 2 is the sound reading of `all`: an unknown effect may reach the
caller's storage through a global that aliases it. The imprecision is rule 1.

## Fix direction

Make a store to a module-level global contribute `all` only when the
global's type can root storage (holds an RC handle or a pointer, the same
test that makes `_MsP.classify` answer NONE for an inert parameter). An inert
global's store mutates only its own static. Check the other consumers of the
mask walk before changing it: rule D3 (`plans/reference/PARALLELISM_RULES.md`)
is answered in the same file, and the mutable-static half of rule D1
(`d1_record_global_write`) must keep seeing the write.

## Fix

`_MsP.walk`'s whole-variable store to a module-level global sets `m.all`
only when `_msp_type_may_root` holds for the global's type: an RC handle, a
pointer, or a move-only value (the predicate `type_contains_rc_type` ∪
pointer containment that `_msp_atom_root` already applies). A store to an
inert global (`i32`, a struct of scalars) contributes nothing to the mask.
That is the verdict a FIELD store into the same global already got:
`g.n = v` reaches `_msp_atom_root` through `_msp_store_prefix`, which answers
NONE for an inert type, so only the whole-variable spelling was imprecise.

Soundness, per consumer of the mask:

- **Entry invalidation asserts** (`src/codegen/functions/generation.yo`) and
  **E0908 / decision-18 local borrows / the explicit-copy migration**
  (`d3_check_pending` in `src/evaluator/exprs/assignment.yo`) ask whether the
  callee may write the storage an argument names. An inert global is its own
  static: no RC handle and no pointer leads from it to an argument's storage,
  and storing to it releases nothing.
- **D3** asks the same about an argument rooted in an atomic object; an
  `Arc`/`Mutex` payload is heap storage an inert static cannot alias.
- **D1's mutable-static half** keeps seeing the write: the assignment itself
  records it with `d1_record_global_write` (`_d1_record_write` in
  `assignment.yo`), independently of any mask. The mask route only covered a
  `&mut` argument rooted in a DIFFERENT global, which an inert store does not
  write, so that route loses only a false "written" record.

A global whose type can root storage still forces `all`, so a callee that
reassigns a global `ArrayList` or `ref(struct)` keeps asserting every
object argument.

Regression test: "borrowed for: a callee that only writes a scalar global
does not trip the flag through an alias" in
`tests/for_macro_borrow_user_collection.test.yo` (the repro's `label_ctor` and
`label_plain`, plus a struct-of-scalars global written whole and by field).
It panics on the v0.2.69 seed and passes with the fix.
