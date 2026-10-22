# An early return in a derive-generated body skips the drop of a value local

**Severity:** S2 — a leak. A `return` from a function body that a
`derive_rule` produced (`ctx.make_impl` over `body.to_expr()`) drops the
`ref`/`Rc` locals that are live at that point. It does not drop the
value-typed locals that have a `Drop` impl. The same body written by hand in
an `impl` drops both.

**Status:** open. **Found:** 2026-10-23 by the V2b B8 flip probe
(`plans/handover/VBD_B8_PROBE_CENSUS_2026-10-22.md`). Once `String` is a value,
`tests/encoding/json.test.yo`'s "derived decode missing field errors" leaks
1 byte under LeakSanitizer. `derive(FromJson)`'s body
(`std/encoding/json.yo`, `__derive_from_json`) decodes `name` into
`__djf_name`. It then `return`s `.Err(...)` when the `inner` field is
missing, and `__djf_name` is never dropped. On develop the same return
decrefs `__djf_name` (`__yo_decr_rc`), because `String` is a `ref` type
there. The repro below needs no flip and uses develop's std (`e30c0d8ed`).
The v0.2.68 seed and a develop-built binary behave the same.

## Reproducer

`issues/repros/2026-10-23-an-early-return-in-a-derive-generated-body-skips-the-drop-of-a-value-local.yo`:
a `derive_rule(Make, …)` generates `make(k)`. The generated body binds
`__x := match(get(i32(0)), .Some(__j) => __j, .None => { return(.Err(i32(1))); })`
(a `B` with a printing `Drop`). It then returns `.Err(i32(2))` from the second
`match` when `get(k)` is `.None`.

```text
true
```

Expected: `drop B`, then `true`. With the same body written by hand as
`impl(P, Make(make : (k -> ({ … }))))`, it prints `drop B` and `true`.

The emitted C shows the difference. The hand-written body calls
`B`'s drop on `__x` before each of the two early `return`s. The derived body
has no drop on either path. Renaming the locals (no `__` prefix) or giving
the lambda a full `fn(k : i32) -> Result(Self, i32)` signature does not change
the result.

## Root cause (hypothesis)

The early-return epilogue ("Drop local variables before early return",
`src/codegen/`) lists the owned value locals that the function generation
context registered for the body. The `ref` locals reach it through the
deferred-decref list, which works in both cases. The value locals of a
derive-generated body are bound while the derive's impl is being evaluated,
and they are evidently not registered with the function that codegen later
emits. The probe did not trace the registration; this is a reading of the C.

## Fix direction

Register a derive-generated body's owned value locals like those of a
written body. The regression test is the repro, which should print
`drop B` before `true`.

## Why it matters for the release plan

After B8, every `derive(FromJson)` error path that has already decoded a
`String` or a list field leaks it. Any other `derive_rule` whose body binds
an owned value local and returns early leaks the same way.
