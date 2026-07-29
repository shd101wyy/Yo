# yo-self: `std/string/string` swallows one `usize` vs `u8` unify error — the NOISE BASELINE

Status: OPEN (harmless-looking, but it is the swallow-probe noise floor)

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
