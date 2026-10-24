# A callee that writes a scalar global is assumed to mutate every argument

**Severity:** S2 — a valid program panics. A read-only `self : &Self` method
that passes `&self.name` to a function which only bumps a module-level `i32`
counter gets the borrowed `for`'s entry invalidation assert. Called through a
second handle inside `for(&mut bag, …)`, it panics with "container operation
while an interior reference … borrows from it".

**Status:** open. **Found:** 2026-10-24 by the review of
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
