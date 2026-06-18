# yo-self: `comptime_str.to_string()` → `String` mis-codegens

## Status

OPEN. A no-interpolation backtick / explicit `"...".to_string()` used where a
runtime `String` is expected mis-compiles. NOT effect- or fn-pointer-specific
(it was first surfaced as the "effects backtick-arg edge", then isolated to this
general bug). Synchronous effects sidestep it with `String.from(...)` messages.

## Minimal reproducers (TS prints `hello` for all; yo-self fails)

**A — return position / fn arg (FAILS TO TRANSPILE):**
```rust
mk :: (fn() -> String)(`hello`);          // or `"hello".to_string()` — identical
main :: (fn() -> unit)({ println(mk()); });
```
yo-self emits `return // Failed to transpile ("hello".to_string)();` — the
`comptime_str.to_string()` call expr has NO ExprInfo (its def-time eval, under
`expected_type = String`, threw and was swallowed by the def-eval trial wrapper).

**B — `:=` binding (UNDECLARED IDENTIFIER):**
```rust
mk :: (fn() -> String)({ s := `hello`; s });
```
yo-self: C error `use of undeclared identifier 's'` — the backtick value is a
comptime constant, so the init-assignment emits no runtime declaration, yet `s`
is later used as a runtime value.

**C — statement level (COMPILES BUT EMPTY):**
```rust
main :: (fn() -> unit)({ s := "hello".to_string(); println(s); });
```
yo-self compiles + runs but prints NOTHING (TS prints `hello`) — the
`comptime_str.to_string()` result lowers to an empty String.

## Root (isolated 2026-06-18)

`"hello"` is `comptime_str`; `.to_string()` is meant to yield a runtime `String`.
yo-self appears to fold `comptime_str.to_string()` to a COMPTIME constant whose
codegen is broken: in a value/return position it has no ExprInfo (eval threw under
expected-String) → "Failed to transpile"; bound to a var it gets no runtime
declaration → undeclared; at statement level it lowers to an empty String. The
fix likely belongs in how `comptime_str.to_string()` is evaluated under an
expected `String` type and/or how its comptime-String result is lowered by
`generate_comptime_value` (String/StructVal case). `String.from("hello")` (which
does NOT go through comptime_str.to_string) works correctly, which is the current
workaround.

## Why it matters / priority

This is the root of the documented "effects backtick-arg edge"
(`issues/yo-self-sync-effect-codegen-unported.md`) — `raise(\`msg\`)` passes a
backtick String to a handler. Deprioritized vs unwind part 2 + parallelism for the
effects subsystem (effects are exercisable with `String.from`), but it is a
GENERAL `String`-codegen correctness bug worth fixing on its own.
