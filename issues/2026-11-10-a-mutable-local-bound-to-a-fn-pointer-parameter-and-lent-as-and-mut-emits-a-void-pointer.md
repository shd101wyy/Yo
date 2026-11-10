# A mutable local bound to a `fn` pointer parameter and lent with `&mut` emits `void*` and fails the C compile

**Severity:** S2: a program the checker accepts, and the diagnostics of the sibling
issue name as "the working form", fails in the C compiler.

Found while gating `issues/fixed/2026-11-08-a-by-value-fn-parameter-in-a-generic-body-is-reported-as-a-read-only-borrow.md`.
The same on develop (`ed53a0795`) and on the fix branch, so it is not a regression.

## Reproduction

```yo
apply :: (fn(generic(A : Type, B : Type), x : &Option(A), f : (fn(a : &A) -> B)) -> Option(B))({
  mut(g) := f;
  x.map(generic(B), &mut g)
});
main :: (fn() -> unit)({
  o := Option(i32).Some(i32(1));
  inc := (fn(a : &i32) -> i32)(a.* + i32(1));
  _x := apply(generic(i32, i32), &o, inc);
});
export(main);
```

`yo compile r.yo --optimize 2` passes the evaluator and fails in clang:

```text
error: incompatible pointer types passing 'void **' to parameter of type 'int32_t (*)(int32_t)'
```

The emitted C declares the local as `void* __yo_v_g = __yo_v_f;` and then passes
`(&(__yo_v_g))` to the `Option.map` specialization whose slot is `int32_t (*)(int32_t)`.
So the mutable local of a function-pointer type is typed `void*` instead of the
function-pointer type, and the `&mut` argument is a `void**`.

## Likely cause

Codegen's type spelling for the local `mut(g) := f` where `f`'s type is a `fn`
value (a bare function-pointer type) falls back to `void*`; a by-value parameter
`f` itself is spelled correctly.

## Status

Open, not fixed. `tests/parameter_modes.test.yo` carries no case for it (the case that
exposed it was dropped from the test for the sibling issue). A fix needs a test that
runs this program.
