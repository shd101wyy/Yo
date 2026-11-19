# The rc-write census lists a write inside `comptime_expect_error`

**Severity:** S3 — `YO_AUDIT_RC_WRITE` printed a census line for a write the evaluator rejected inside `comptime_expect_error`, which never reaches codegen; an audit-only knob reported a write that does not exist

**Status:** FIXED (found 2026-11-19 by the R7 lane while re-pinning `tests/cli-cases/audit-rc-write-census` after the `ref(...)` drop; develop `939fe7160` walks the same way)

## Reproducer

```yo
Counter :: struct(n : i32);
main :: (fn() -> unit)({
  mut(h) := Rc.new(Counter(n : i32(1)));
  comptime_expect_error(h.n = i32(5), "read-only through the handle");
});
export(main);
```

`YO_AUDIT_RC_WRITE=1 yo compile main.yo --skip-c-compiler` printed

```text
main.yo:4:26 [rc-write] kind=assign handle=rc root=rooted proved=no type=Rc(Counter) `(h.n)`
```

although the write is E0919 and only exists inside the `comptime_expect_error`
operand.

## Root cause

`_rcw_walk` (`src/evaluator/effects/mutation_summary.yo`) walks a function
body codegen emits, and it recursed into every call's arguments, including the
operand of `comptime_expect_error`. That operand was evaluated at compile time
(so it has ExprInfo for the walk to read) and is never emitted.

## Fix

`_rcw_walk` returns at a `comptime_expect_error` call. Test:
`tests/cli-cases/audit-rc-write-census` keeps the E0919 row and pins an empty
census.
