# A construction passed to an unknown-effect callee escapes the borrow assert

**Severity:** S1 — a safe-looking program reads freed memory. A method that
passes a struct built from its receiver's storage
(`poke(Holder(items : self.items))`) to a callee whose mutation mask is `all`
gets no entry invalidation assert. Called through a second handle inside a
borrowed `for(&mut bag, …)`, the callee's push reallocates the walked buffer
and the loop writes through a dangling element pointer.

**Status:** open. **Found:** 2026-10-24 while reviewing
`issues/fixed/2026-10-23-a-read-only-method-iterating-a-value-field-asserts-its-receiver-unborrowed.md`.
The v0.2.68 seed, develop `f271ed005` and that fix behave the same.

## Reproducer

`issues/repros/2026-10-24-a-construction-passed-to-an-unknown-effect-callee-escapes-the-borrow-assert.yo`:

- `poke(h : Holder)` pushes into `h.items` and also writes a module-level
  counter. The global write makes its mask `all`.
- `Bag.grow(self : &Self)` calls `poke(Holder(items : self.items))`.
- `main` calls `other.grow()` inside `for(&mut bag, x => { …; x = (x + 1) })`,
  where `other := bag`.

Under `--sanitize address --allocator system` this reports a
heap-use-after-free. The expected result is the borrow panic
("container operation while an interior reference … borrows from it").

## Root cause

When a callee's mask is `all`, `_MsP.walk` (`src/evaluator/effects/mutation_summary.yo`)
attributes the unknown effects to each argument's root, deeply, through
`_msp_mask_add_root`. For a SHELL root (fresh storage that holds rooted
handles) that function adds nothing. But a deep mutation through the shell
reaches the handles it holds, which here are `self.items`. The per-parameter
path of the same walk already treats `SHELL && deep` as `all`, so the two
paths disagree.

## Fix direction

Treat a SHELL argument of an `all` callee as `all` in the attribution path,
the same as the per-parameter path does. Measure the precision cost first.
`box` and `rc` are themselves `all`, because a diverging
`.None => __yo_panic(…)` arm joins ROOTED into their `block` local. So every
`RefCell.new(v)` (`box(_RefCellSlot(v))`) would gain an assert on `v` unless
that join is fixed too: a call of `never` type should contribute nothing to
a join.
