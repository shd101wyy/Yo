# A generic function's result at `T := &U` is lowered as a projection, and its C does not compile

**Severity:** S2: a program the checker accepts fails in the C compiler. A
generic function returning `T`, specialized at `T := &U`, is lowered as a
`-> &T` projection, so its C returns `T*` from a function declared to return
`const T**`.

> Found 2026-11-06 while testing N1e-2b PR 2b (decision 43 step 2, the R1
> read rule). PR 2b makes `id(r)` with `r : &i32` bind `T := &i32` (before it,
> E0926 rejected the call outside the exempt trees). VERDICTS-23 assigns this
> case to N2c as R3.

## Reproducer

```yo
rr_id :: (fn(generic(T : Type), v : T) -> T)(v);
main :: (fn() -> unit)({
  y := i32(6);
  r := &y;
  _s := rr_id(r);
  ()
});
export(main);
```

`yo check` accepts this program on PR 2b. `yo compile` fails:

```text
error: incompatible pointer types returning 'int32_t *' (aka 'int *') from a function with result type 'const int32_t **' (aka 'const int **') [-Werror,-Wincompatible-pointer-types]
yo: error: compile: C compiler failed (exit 1)
```

The binding is also mistyped. `_s` becomes a projection's reference binding
of type `&&i32`, so a later `type_of(_s)` reads it whole (E0926).

## Root cause

`fn_result_is_ref` holds for the specialized function type, because its
result slot is the reference type `&i32`. That type is a `T := &U` VALUE, but
every reader treats the call as a projection:

- the call site reads its result through (`(*call)`);
- the callee's lowering returns `&(body)`;
- `_bind_projection_result` binds `_s` as a reference binding.

A result typed `&U` because the declaration spells `-> &T` is a projection. A
result that is `&U` only because a type parameter was bound to it is a value.
That distinction is not kept in the function type.

## Fix

VERDICTS-23 R3 (N2c): keep the declared result's shape (a spelled `&` versus
a type parameter) through specialization, and lower a `T := &U` result as a
pointer value. Test: `tests/origins/reference_read_rule.test.yo`'s
`rr_id_of_reference` gains a call with `rr_read(_s)` at runtime.
