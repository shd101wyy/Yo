# yo-self: `std/string/string` swallows one `usize` vs `u8` unify error — the NOISE BASELINE

Status: FIXED 2026-08-06 — see RESOLUTION at the bottom

## Why this matters

Every swallow-probe investigation must SUBTRACT this line before treating a
swallowed message as a defect:

```
__DBG_W Error: Cannot unify incompatible types: "usize" and "u8"
```

It fires **exactly once per program** for any file that (transitively) imports
`std/string/string` — which is nearly every file, since `std/assert` →
`std/fmt/to_string` → `std/string`, and most tests `open(import("std/string"))`.

It has already caused two wrong root-cause attributions in the bootstrap
campaign (contracts_phase0 arms 2/18, and the first pass at
`tests/comptime.test.yo`), because the line looks like a real def-time type
error at the file being investigated.

## Reproduce

```rust
{ __x } :: import("std/string/string");
main :: (fn() -> unit)(());
export(main);
```

`s1 check` on that file (with the `__DBG_W` probe at
`yo-self/evaluator/exprs/_expr.yo`'s `_evaluate_expression_wrapper` catch-all)
prints the line once. A file with no imports prints nothing — that is the true
zero baseline.

Bisected: `std/string/rune` is clean; `std/string/string` is the source
(`std/string/unicode` and `std/string/string_builder` inherit it via their own
import of `string.yo`). `std/libc/stdio` is clean.

Not yet localised inside `std/string/string.yo`. Candidate shapes (a `usize`
length meeting a `u8` element type through a positional generic pairing — the
`is_type_0` kind-guard class of bug):

- `ArrayList(u8).with_capacity(<usize>)` — NOT reproducible standalone
- `RawSlice(u8)(ptr : *(u8)(""), len : usize(0))` — NOT reproducible standalone
- `Array(u8, _INT_BUFFER_SIZE).fill(0)` — NOT reproducible standalone

## Impact

The error is swallowed at the def-time catch-all, so one function body in
`std/string/string.yo` never completes its definition-time validation. Nothing
observably breaks today (TS `check ./std` is clean, so the error is
yo-self-only), but the unvalidated body is a latent gap.

## How to localise (next step)

The probe prints only `err.to_string()`, which carries no location. Either
extend the probe to print `ast_expr_to_string(expr)` / the token's file:line at
the swallow site, or copy `std/` to a scratch tree and bisect
`string/string.yo` by deleting method groups (its imports are relative, so a
copied tree resolves).

## RESOLUTION (2026-08-06)

**Root cause: a yo-self evaluator mis-port, not a std type error.** The
scratch-tree bisect landed on `String.trim` (std/string/string.yo), line
`(b : u8) = al(end_idx - usize(1));` — the only place in std/string that
indexes with call syntax on an OPERATOR-EXPRESSION argument under a TYPED
binding. Minimal standalone repro (fires the swallow once):

```rust
{ ArrayList } :: import("std/collections/array_list");
f :: (fn(al : ArrayList(u8), end_idx : usize) -> u8)({
  (b : u8) = al(end_idx - usize(1));
  b
});
main :: (fn() -> unit)(());
export(main);
```

An lldb backtrace on the swallow handler (`note_def_time_swallow`, hit while
the throw-site native stack is intact — compile the emitted `.c` with
`-O1 -g -fno-inline` to keep the `static inline` fns visible) gave the chain:

```
evaluate_assignment            (b : u8) = ...   → ctx.expected_type = u8
→ evaluate_function_call       al(end_idx - usize(1))
→ try_to_call_with_index_trait step 6 "runtime path"
→ evaluate_expression(arg)     ← ambient expected_type STILL u8 (the leak)
→ evaluate_function_call       `-` operator
→ try_to_call_function_with_arguments
→ synthesize_types             → throw: Cannot unify "usize" and "u8"
→ _evaluate_expression_wrapper catch-all (the no-exn wrapper) — swallowed
```

TS clears the expected type at EVERY index-argument evaluation
(`expectedType: undefined` — src/evaluator/calls/index-trait.ts:283, :360,
:446, :801, :920). The yo-self port dropped that at all four of its
index-arg eval sites in `yo-self/evaluator/calls/index_trait.yo`
(`_try_comptime_array_index`, `_try_comptime_string_index`,
`_try_comptime_custom_type_index`, and `try_to_call_with_index_trait`'s
runtime path), so the binding's element-typed expectation leaked into the
index argument's operator dispatch and produced a false unify failure. The
body still validated via the operator fallback path — the line was pure
try-then-fail noise — but it cost two wrong root-cause attributions.

**Fix:** save/clear/restore `ctx.expected_type` around the arg eval at all
four sites (`yo-self/evaluator/calls/index_trait.yo`), mirroring TS. The
`evaluate_expression` there is the no-exn wrapper, so no throw can skip the
restore.

**Verified:** the minimal repro and the `std/string/string` import repro both
check clean with ZERO `usize`/`u8` swallows; the `__DBG_W` wrapper-probe set
for a string-importing file is now IDENTICAL to the no-import baseline (the
remaining 3 `Type mismatch for type member "_0"/"_1"` lines are prelude
deferred-generic-trial noise that TS swallows identically by design). The
noise baseline for swallow probes is now ZERO extra lines per
`std/string/string` import.
