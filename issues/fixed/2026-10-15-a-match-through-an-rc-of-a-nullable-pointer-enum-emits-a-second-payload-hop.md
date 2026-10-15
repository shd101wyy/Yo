# A match through an `Rc` of a nullable-pointer enum emits a second payload hop

**Severity:** S2 — a valid program fails to C-compile: a `match` that looks through an `Rc` into a two-variant enum whose one payload is a reference type emits `r->_u42_->_u42_`.

Found 2026-10-15 while probing whether a match binding of an `Rc` payload aliases it (branch `perf/type-key-memo-identity`). Not fixed there.

## Reproducer

```yo
{ ArrayList } :: import("std/collections/array_list");
{ println } :: import("std/fmt");
N :: enum(A(xs : ArrayList(i32)), B);
main :: (fn() -> unit)({
  r := rc(N.A(ArrayList(i32).new()));
  n := match(r, Rc(.A(xs)) => xs.len(), _ => usize(99));
  println(n.to_string());
});
export(main);
```

`yo compile repro.yo -o repro`:

| compiler | result |
|---|---|
| the v0.2.62 release (the seed) | compiles; prints `0` |
| develop at 31ef8d7a3, tree-built | `error: no member named '_u42_' in 'struct __yo_t_…_struct'` (twice) |

The emitted C:

```c
if (!(__yo_v_r->_u42_->_u42_ != NULL)) goto __yo_m160718_a0;
__yo_t_13923063681565194145* __yo_v_xs = __yo_v_r->_u42_->_u42_;
```

`__yo_t_13923063681565194145` is `ArrayList(i32)`, a counted struct with no `_u42_` member.

## Cause

`N` has one data variant whose payload is a pointer, so it gets the nullable-pointer layout: the enum value IS the payload pointer. `r->_u42_` (the `Rc` cell's payload) is then already `xs`. The look-through lowering adds a second `_u42_` hop, as it would for a tagged enum. The 2026-10-14 change that lowers a match through an `Rc` handle to a `switch` on the payload (`_lookthrough_switch_cell`, `src/codegen/exprs/match.yo`; `issues/fixed/2026-10-14-a-match-on-an-rc-handle-lowers-to-a-goto-chain.md`) landed after v0.2.62 and is the first suspect. Its tests use the compiler's `TypeValueNode`, a tagged enum.

## Fix criteria

The reproducer compiles and prints `0`. A test in `tests/` covers a match through an `Rc` into a nullable-pointer enum, with both a binding arm and a `_` arm.

## Fix

Confirmed: `generate_match_expression` (`src/codegen/exprs/match.yo`) rewrote
the subject to the cell's payload field (`r->_u42_`) whenever every arm looks
through one `Rc` cell, but only the tagged-union switch reads through the
arms' wrapper. A nullable-pointer payload (this report) or a fieldless enum
payload (`Rc(.Red) => …`, which emitted a second hop on a C enum: "member
reference type is not a pointer") fell back to the test chain with the
rewritten subject, and the chain added the arm's own `Rc` hop. The rewrite now
happens only when the tagged-union switch takes it; every other payload keeps
the handle as the subject, as v0.2.62 did.

Test: `tests/match_nested.test.yo`, "a match through an Rc into a
nullable-pointer or fieldless enum reads the payload once" (a binding arm, a
`_` arm, the all-variants form, a consuming match, and a fieldless enum). It
fails to C-compile on develop `0684c9c40` and passes with the fix.
