# A `fn` value lent to a projection's `&Impl(Fn(...) -> &T)` slot emits a `void**` C argument (clang rejects it)

**Severity:** S2. A program that type-checks fails in the C compiler: the lent `fn` value's address is passed as
`void**` where the specialization's parameter is a function pointer.

Found 2026-11-10 by the bugs2 lane while writing the regression test for
`issues/fixed/2026-11-08-a-projection-yielding-a-reference-returning-callables-call-is-rejected.md`.

## Reproducer

`issues/repros/2026-11-10-a-fn-value-lent-to-a-projections-impl-fn-slot-emits-a-void-pointer-argument.yo`
(`yo check` passes; `yo compile`):

```text
t6.c:2285:114: error: incompatible pointer types passing 'void **' to parameter of type 'int32_t *(*)(int32_t *)'
yo: error: compile: C compiler failed (exit 1) on t6.c
```

The callee is a projection (`-> &i32`, body `&f(v)`) whose slot is `f : &Impl(Fn(x : &i32) -> &i32)`, and the
argument is `&g` with `g := (fn(x : &i32) -> &i32)(&x.*)`, a `fn` VALUE (not a closure literal). The same slot
with a value result (`-> i32`, body `f(v).*`) compiles and runs, and so does an inline closure literal lent
`&(x => &x.*)`.

## Where to look

The call's argument emission for a `&` lend of a function-pointer-typed local when the specialization's callee
result is a reference (the `__yo_ref_spill_N` path): it casts the address to `(void**)` instead of loading the
function pointer.

## Expected

The program compiles and runs. Not fixed in the lane that found it; the regression test belongs with the fix
(the issue's reproducer as `bs_fwd_r(&g, &o).*` in `tests/borrow_spelling.test.yo`).
