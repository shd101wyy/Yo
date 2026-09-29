# A `:=` whole-value pattern whose sub-pattern fails evaluation SIGFAULTS `yo check`

**Status: FIXED** by #993 (2026-09-29): `generate_recur` now wraps every
self-call in the escape protocol; the regression cli-cases
`match-at-subpattern-error-reports-cleanly` and
`match-or-alternative-error-reports-cleanly` pin the clean E0609.

**Opened:** 2026-09-28
**Reproduced on:** seed `yo 0.2.45` (installed 2026-09-28), tree `12a69ed8b`
(develop, #985).

## Verbatim

```
$ yo check ./tmp/fixme.yo
Segmentation fault (exit code 0xC0000005, no diagnostic)
```

## Minimal reproducer

```rust
E :: enum(A(x : i32), B);
m :: (fn(e : E) -> i32)(
  match(
    e,
    .A((r := 1.5)) => i32(1),
    _ => i32(0)
  )
);
```

Any arm pattern `(name := <sub>)` whose SUB-pattern compilation throws crashes
the compiler when the enclosing `fn` body is trial-evaluated at definition
time. The same throwing sub-pattern WITHOUT the `:=` wrapper reports cleanly:

```
error[E0609]: Pattern 1.5 cannot match a value of type i32 (no `==` between them)
```

## Variants measured (all 0xC0000005)

- `.A((r := 1.5))` on `A(x : i32)` — a float literal against an int payload.
- `(r := 1.5)` at TOP level on an `i32` scrutinee (no variant wrapper).
- `.Cons(2, (rest := .Nil))` where `tail : Box(Self)` (E0609 "needs an enum
  value…").
- `.A((r := .C))` — variant-not-found inside the `:=`.
- `((r := 1.5) | (r := 2))` — the same through an or-pattern alternative
  (`recur` in the or-alternative loop).

Controls that behave (clean error / correct accept): the identical throwing
sub-pattern without the `:=` wrapper (`.A(1.5)`); a guard referencing an
undefined fn; `(r := undefined_var)` (that sub is a BINDING, correctly
accepted); `(r := <valid pattern>)`; and at runtime an `unwind` out of a
recursive callee (that path is a longjmp to the closure's defining fn, not a
flag-carrying escape — it never crosses the recur call boundary).

## Root cause (confirmed in the emitted C)

`generate_recur` (`src/codegen/exprs/recur.yo`) emits the recursive self-call
WITHOUT the escape protocol every may-unwind direct call gets:

```c
__yo_effect_escaped = 0;
<call>;
if (__yo_effect_escaped) { /* drops */ return <dummy>; }
```

A recursive callee throws as readily as any call — it runs the same body — so
`exn.throw` deep inside the recursion sets `__yo_effect_escaped` and the
callee returns its `{0}` early-return value. The recur call site never checks
the flag; the NEXT may-unwind call's pre-call `__yo_effect_escaped = 0`
CLEARS it, and the caller CONTINUES with the `{0}` as if it were the result.
In `compile_pattern`'s `(name := p)` case (`sub := recur(sub_expr, …)`) that
meant a `Pattern.At` with a NULL `sub`, and the SIGSEGV fired the moment
anything walked the pattern (`pattern_to_string`/`match_value`/usefulness).
Measured in the emitted C of `yo build`:
`yo-out/.../yo.c:678616` (the At-case recur call) has no check before the
next call's flag reset at `:678620`; the or-alternative recur and the Box
look-through recur sit under the same hole. Direct `compile_pattern(...)`
calls by NAME (evaluate_match's, `_compile_variant`'s param loop) DO carry
the check — only `recur(...)` call sites lacked it. The identical bug class
was fixed for method dispatch in
`issues/retired/yo-self-stage2-unwind-check-coverage.md` (same symptom:
"after a throw deep inside a method, the caller CONTINUED with a garbage
result").

## Fix

`generate_recur` now wraps the call in the escape protocol at all three of
its exits (named result temp, unit statement, and a fresh-temp fallback for
the bare-expression case): reset before, `emit_effect_unwind_check` (transitive)
after. Regression: cli-cases `match-at-subpattern-error-reports-cleanly` and
`match-or-alternative-error-reports-cleanly` (both SIGSEGV'd before, report
E0609 after).

Note: inside a `test("…", { … })` body the crash does not reproduce under
`yo check` — check does not semantically evaluate `test` bodies — so the
repro must be at module level.
