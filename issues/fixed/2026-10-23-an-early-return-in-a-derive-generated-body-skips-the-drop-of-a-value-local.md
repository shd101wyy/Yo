# An early return in a derive-generated body skips the drop of a value local

**Severity:** S1 — a silently skipped destructor. A `return` from a
function body that a `derive_rule` produced (`ctx.make_impl` over
`body.to_expr()`) drops the `ref`/`Rc` locals that are live at that point. It
does not drop the value-typed locals that have a `Drop` impl, so their `Drop`
side effects never run and their storage leaks on every call that takes the
path. The same body written by hand in an `impl` drops both. (Filed as S2;
raised to S1 by the probe's review, 2026-10-23: `issues/README.md` puts
silently wrong results and unbounded leaks under S1.)

**Status:** fixed 2026-10-23 (branch `fix/derive-early-return-drop`; see
[Fix](#fix)). **Found:** 2026-10-23 by the V2b B8 flip probe
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

## Root cause (hypothesis, superseded by [Fix](#fix))

The early-return epilogue ("Drop local variables before early return",
`src/codegen/`) lists the owned value locals that the function generation
context registered for the body. The `ref` locals reach it through the
deferred-decref list, which works in both cases. The value locals of a
derive-generated body are bound while the derive's impl is being evaluated,
and they are evidently not registered with the function that codegen later
emits. The probe did not trace the registration; this is a reading of the C.

## Fix direction (as filed)

Register a derive-generated body's owned value locals like those of a
written body. The regression test is the repro, which should print
`drop B` before `true`.

## Why it matters for the release plan

After B8, every `derive(FromJson)` error path that has already decoded a
`String` or a list field leaks it. Any other `derive_rule` whose body binds
an owned value local and returns early leaks the same way.

## Fix

The bug was not in registration and not derive-specific in mechanism: the
M3 driver in `_evaluate_begin_expression_impl`
(`src/evaluator/exprs/begin.yo`) skipped every local and every parameter
whose binding token's module path starts with `auto-generated://`, the
pseudo-path `.to_expr()` stamps on code parsed from a string. The driver
attaches a `___drop` of a CONSUMED local (one the body moves later, here
`__x` into `Self(x : __x, …)`) to each `return`/`unwind` before the move and
feeds the effect-escape list; with the exemption, a derive-generated body got
none of them. The `ref`/`Rc` locals the issue saw released took a different
path (they are not consumed on develop, so the scope-end list carried them).
The exemption came over from the TypeScript compiler
(`begin.ts`, tag `src-attic-final`) with no stated reason. Its likely purpose,
ordering tokens of different streams, is already covered: the attach walk and
the escape gate compare tokens only within one stream
(`_m3_tokens_comparable`: same module path and same input) and decline
otherwise, so dropping the exemption cannot attach a drop after a move.

The fix removes the exemption for locals and for parameters, so a
derive-generated body and the same body written by hand get the same exit
drops. The emit-diff gate over `src/main.yo` (develop binary vs the fixed
one, same source) differs only in numbering, so no compiler-internal
derived body (`___dup`/`___drop`/`Clone`/`Eq`/`Hash`) changed.

The adversarial review of other exits found two more bugs, fixed on the same
branch:

- `break`/`continue` before a later move skipped the drop in hand-written and
  derive-generated code alike
  (`issues/fixed/2026-10-23-a-break-or-continue-before-a-later-move-skips-the-drop-of-a-loop-body-local.md`).
- Checked arithmetic in a derive-generated body emitted C that does not
  compile
  (`issues/fixed/2026-10-23-checked-arithmetic-in-a-derive-generated-body-emits-c-that-does-not-compile.md`).

And one, filed and not fixed here: an `unwind` through a type-qualified
method call is not caught by the frame that installed the handler
(`issues/fixed/2026-10-23-an-unwind-through-a-method-call-is-not-caught-by-the-frame-that-installed-the-handler.md`).

**Regression tests:** `tests/derive.test.yo`, "an early return from a
derive-generated body drops a live value local" and "an effect unwind out of a
derive-generated body drops a live value local" (a `Drop` counter; both fail
under the v0.2.68 seed with `__x is dropped once …`). Under the B8 flip
probe's std (`probe/v2b-b8-flip-census`), `tests/encoding/json.test.yo`'s
"derived decode missing field errors" leaks 1 byte under LeakSanitizer with a
develop-built binary and passes with the fixed one.

