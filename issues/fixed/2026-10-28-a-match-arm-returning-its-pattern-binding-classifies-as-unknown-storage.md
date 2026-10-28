# A match arm returning its pattern binding classifies as unknown storage

**Severity:** S1 — it blocked the v0.2.72 release (develop `49aca7a72`'s
battery 40622912600 failed on every OS) and a correct program panicked: a
function that only moves a `ref` parameter into `RefCell.new(b)` or `box(b)`
got the borrowed `for`'s entry assert, which fired through a second handle
inside `for(&mut bag, …)`.

**Status:** fixed 2026-10-28 on `fix/develop-sai-a2-borrowed-for-mask`.

## Symptom

`tests/for_macro_borrow_user_collection.test.yo`, "borrowed for: read-only
methods iterating a value field by value, through an alias, do not trip the
flag", on every battery shard, wasm32 and the hollow sweep:

```text
panic: container operation while an interior reference (a 'ref' into an element/field) borrows from it
```

exit 134. The step that panics is `cell := keep_in_cell(other)`, where
`keep_in_cell :: (fn(b : VBag) -> RefCell(VBag))(RefCell(VBag).new(b))`.

Bisected: passes with develop `0f8882138` and with W4 (#1645); fails from
#1646 (`324bb84a0`, static-argument inference A2+A3), which made `box`
forward to the new `Box(T).new(value, alloc : alloc)`.

## Root cause

Not the call through a type constructor: the mutation summary
(`src/evaluator/effects/mutation_summary.yo`) resolves `Box(V).new(...)` and
analyzes its body as it analyzes any callee. The defect is older and sits in
that body. `YO_DEBUG_BORROW_MASK=1` on a reduction prints, for `Box.new`:

```text
[borrow-all] store-through-rooted: (*(_BoxOwner)(block).(*))
[borrow-roots] … (value,alloc,) all=true … b=fresh block=rooted cell=rooted
```

`block := match(…, .Some(b) => b, .None => __yo_panic(…))`: `b` is a fresh
allocation, yet `block` is unknown storage, so the two stores into the new
block count as writes to unknown storage and the mask is `all`. A gated print
in `_msp_atom_root` showed why: for the arm body `b`, the atom's recorded env
holds no `b` (`scope_variables` and `get_variables_from_env` both return
nothing), and an unresolvable read is ROOTED. The match evaluator trims each
arm body's recorded env to the match's depth after evaluating it
(`src/evaluator/exprs/match.yo`, "Trim the arm body's recorded env"), which
pops the frame holding the pattern bindings. When the arm body IS the binding,
its own ExprInfo carries the trimmed env. `{ c := b; c }` resolves (the read
of `b` is a nested node with the untrimmed env); `.Some(b) => b` does not. Any
`match(x, .Some(p) => p, …)` with a pointer or handle payload classified its
result as unknown storage: `Option.unwrap`'s result too.

`box` had the same body before #1646 and was `all` too. That was harmless at
`RefCell.new`'s call `box(slot)`: a callee whose mask is `all` attributes the
mutation to its arguments' roots, and the argument is a fresh constructor
shell, which that branch skips. After #1646, `box`'s own walk turns
`Box.new`'s `all` into precise bits: deep mutation of `box`'s parameters
`value` and `alloc`. At `RefCell.new`'s call those bits are read per
parameter, and both are conservative there: a deep mutation of a shell
argument is `all` (what the shell holds is not fresh), and `alloc` is an
omitted default with a mask hit. `RefCell.new` became `all`, `keep_in_cell`'s
parameter got the entry assert, and the read through `other` panicked.

Calling `box(b)` directly on a parameter was already broken before #1646:
`keep_boxed :: (fn(b : VBag) -> Box(VBag))(box(b))` panics the same way with
the develop `0f8882138`, W4 and `49aca7a72` binaries.

## Fix

`_msp_atom_vars` (`mutation_summary.yo`) resolves an identifier read the way
codegen already does when the recorded env lacks the binding
(`src/codegen/exprs/return.yo`, "the evaluator's `source_variable` stamp …
is the authoritative answer"): the env lookup first, then the atom's
`source_variable` when its name matches. `_msp_atom_root` (classification) and
`_msp_atom_local_name` (taint) both use it, so the arm-body binding reads as
the local it is.

That alone moved the failure one step: with `block` fresh, the store of
`value` into the block makes it a shell (fresh storage that holds a handle),
and `cell := (*T)((*u8)(block).add(_BOX_PREFIX_SIZE))` then classified as
unknown storage. The pointer method `add` returns `PARAM(0)` (its body is
`__yo_ptr_add(self, count)`), and the caller mapped every `PARAM(j)` result
through `_msp_extract`, which reads a shell's CONTENTS as unknown. That is
right for a value read out of argument j (`p.*`, a field, a payload) and wrong
for argument j's value itself (a cast, a pointer offset, `.Some(p)`). The
root now records which one it is: `_MspRoot.contents` is set by
`_msp_extract` (and by a pure builtin other than `__yo_ptr_add`,
`__yo_ptr_sub` and `__yo_as`, since `__yo_ptr_read` and `__yo_array_index`
read contents), joins OR it, and a callee whose result is `PARAM(j)` with
neither `deep` nor `contents` set yields the argument's own root. Only a
shell argument classifies differently (shell instead of unknown); every
other root maps to the same answer as before.

With both, `Box.new`'s block and cell are shells, its stores land in fresh
storage, and the masks of `Box.new`, `box`, `RefCell.new` and `keep_in_cell`
are empty (`YO_DEBUG_BORROW_MASK=1`: `params=00`, `params=00`, `params=0`).

The forwarding conservatism at `RefCell.new` (shell argument, omitted default)
is left as is: both rules are sound, and with an exact callee mask they no
longer fire.

## Regression tests

`tests/for_macro_borrow_user_collection.test.yo`:

- "borrowed for: read-only methods iterating a value field by value, through
  an alias, do not trip the flag" (the battery failure; `RefCell.new` →
  `box` → `Box.new`).
- "borrowed for: boxing the object through an alias does not trip the flag"
  (new; `box(b)` of a parameter, which failed before #1646 too).

Both fail with the develop `49aca7a72` binary and pass with the fix.

## Related

`rc(b)`/`arc(b)` of a `ref` parameter still carry a false assert, for a
different reason (the allocation-scope externs in their `alloc` arm):
`issues/2026-10-28-rc-of-a-ref-object-parameter-asserts-it-unborrowed.md`.
