# `recur(..., &mut local)` passes the struct by value in the emitted C

**Severity:** S2 — a valid program does not compile. `recur` called with `&mut` lending a local value struct emits C that passes the struct where the parameter is a pointer, and clang rejects it. Calling the function by its name instead of `recur` works.

Found 2026-11-05 by V5 part B with the v0.2.74 seed. `src/evaluator/exprs/begin.yo` threads two value structs (`DupCallsResult`, `_ICScan`) as `&mut` through `recur`, and the stage-1 build failed in the C compiler.

## Reproducer

`issues/repros/2026-11-05-recur-lending-a-local-mut-passes-the-struct-by-value.yo`:

```yo ignore
S :: struct(n : i32);
count :: (fn(k : i32, s : &mut S) -> unit)({
  s.n = (s.n + i32(1));
  if(k > i32(0), {
    mut(local) := S(n : i32(0));
    recur(k - i32(1), &mut local);
    s.n = (s.n + local.n);
  });
});
```

`yo compile <repro> -o a.out`:

```
recur_mut.c:2430:158: error: passing '__yo_t_3849895013826864930' (aka 'struct __yo_t_3849895013826864930_struct') to parameter of incompatible type '__yo_t_3849895013826864930 *'; take the address with &
 2430 |     yo_id_12368360832408284279000000(((int32_t)__yo_sub_chk_s(...)), __yo_v_local);
```

With `count(k - i32(1), &mut local)` in place of `recur(...)`, it compiles and prints 4.

## Root cause (not yet confirmed)

`recur`'s call lowering emits each argument's value expression, and it skips the address-of a lent place that the named-call path inserts for a `&mut` (and `&`) parameter of a value type. Before V5 part B every such argument was a `ref` handle, which is already a pointer in C, so the difference never showed.

## Workaround in the tree

`src/evaluator/exprs/begin.yo` calls `_search_dup_calls` and `_ic_scan` by name at the four sites that lend a local `&mut`.

## Status

Open. The test (the repro as a codegen-bootstrap or language test that runs and prints 4) lands with the fix.
