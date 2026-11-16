# A lend of an unsized place emits a deref of the fat pair

**Severity:** S1 (invalid C: a program the evaluator accepts does not compile; found on the flip branch before it merged)

## What happened

On the decision 49 S2 flip branch, a `&Dyn(T)` is the fat pair `{data, vtable}` itself, and the place of
the `Dyn` behind it reads `(*pair)`. Three lends kept that place's code where the slot takes the pair:

- a reference binding `r : &Dyn(T)` passed on to a `&Dyn(T)` parameter (`_area(r)` in a `match` arm);
- `.Some(&self.cause.*)` into an `Option(&Dyn(T))` payload;
- `&_root(s)`, an unsized projection call, as a leaf of a reference-typed `match` (R-TAIL), which took
  the C address of the pair it returned.

clang rejected each one (`tests/ref_payload_binding.test.yo`, `tests/dyn.test.yo`):

```text
error: indirection requires pointer operand ('__yo_t_...' invalid)
  yo_id_...((__yo_t_...)((*__yo_v_r)));
error: assigning to '__yo_t_...' from incompatible type '__yo_t_... *'
  _file____temp_... = (&__yo_ref_spill_2);
```

## Fix

`unsized_lend_pair_code` (`src/codegen/exprs/_expr.yo`) folds a whole-expression `(*X)` to `X`. It is
applied:

- in `_apply_ref_amp` (an argument recorded as a lend of an unsized pointee, or typed as one);
- at an enum constructor's reference payload of an unsized pointee;
- in `chain_leaf_pointer_code`, for a reference-typed chain's leaf over an unsized pointee.

## Tests

`tests/ref_payload_binding.test.yo` (the `&Dyn(Trait)` payload and the borrowing `source` chain), and
`tests/dyn.test.yo`, "a Box(Dyn) lent where a &Dyn is taken".
