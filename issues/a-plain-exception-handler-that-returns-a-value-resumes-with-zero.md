# A plain `Exception` handler that `return`s a value resumes the throw with 0

**Severity:** S1 — silently wrong value: the program compiles and the throw expression evaluates to 0, not the handler's value

**Status:** open
**Found:** 2026-09-30, writing `tests/async/fusion.test.yo` for the await-site
fusion (`plans/backlog/ASYNC_AWAIT_SITE_FUSION.md`).
**Reproducer:** `issues/repros/a-plain-exception-handler-that-returns-a-value.yo`

## Symptom

```rust
checked :: (fn(n : i32, exn : Exception) -> i32)(
  cond(
    (n > i32(100)) => exn.throw(dyn(Boom(msg : `too big`))),
    true => n
  )
);
exn := Exception(throw : (err -> {
  return(i32(7));
}));
println(`sync: ${checked(i32(500), exn)}`);
```

prints `sync: 0` under the v0.2.46 seed. It also prints 0 when the throw
happens inside an `io.async` body awaited from `main`. There is no
diagnostic.

The same code with `ResumableException(i32)` prints `sync: 7`.

## What is known

Measured:

- The value is 0 in a plain function, after an await in `main`, and in an
  `io.async` body. So it is not async-specific.
- With `ResumableException(i32)`, whose `ResumeType` is fixed at the
  handler's construction, the value arrives.

From the docs and code, not measured:

- `docs/en-US/DESIGN.md` presents `Exception` as the unwinding exception and
  `ResumableException(ResumeType)` as the resumable one. So `return(v)` in a
  plain `Exception` handler may be outside the design.
- If it is, the compiler accepts it where it should reject it, and the
  program silently computes 0.
- `Exception.throw` is a `ctl` with a generic `ResumeType`, emitted as one
  `void*`-returning C function for every instantiation
  (`src/codegen/exprs/other_fn_call.yo`, the `ctl_generic_ret` comment; see
  also `issues/fixed/ctl-handler-void-signature-vs-sret-cast.md`). A handler
  body's `return(i32(7))` has no concrete resume type to return into. The 0
  is plausibly that erased return being read at the throw site.

## The decision this needs

Either a plain `Exception` handler may resume with a value, and the lowering
must carry the value to the throw site, or it may not, and `return(v)` in
one is a compile error that points at `ResumableException`. That is a
language question, so the fix waits on it. Until then the silent 0 is a
wrong-result bug.
