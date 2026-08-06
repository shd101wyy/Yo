# yo-self: `comptime_str.to_string()` → `String` mis-codegens

## Status

✅ RESOLVED (2026-06-18) — `_resolve_str_type_from_env` fell back to `t_i32()`; changed to `t_str()`. corpus 72/72.

## (historical) Status

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

## Resolution chain (located 2026-06-18)

The parser desugars a template-string part `"hello"` into `"hello".to_string()`
(parser.ts:180-233). There is NO `to_string` on `comptime_str` in the prelude
(only `to_comptime_string` via the `ComptimeToString` trait). The runtime
`to_string` lives in **`std/imm/string.yo:726`** (str's `to_string -> String`) and
the **`std/fmt/to_string.yo` `ToString` trait**. So `"hello".to_string()` must
resolve via `comptime_str → str → str.to_string() → String`. yo-self's eval of
that chain THROWS (def-eval, swallowed → no ExprInfo → "Failed to transpile"). Fix
target: make the `comptime_str` receiver's `to_string` resolve (coerce
`comptime_str → str` for the method receiver, or bind the `ToString`/str impl)
under an expected `String` type during def-time body eval — then verify the
comptime-folded result lowers (generate_comptime_value String/StructVal case).
NOTE: the corpus largely avoids bare `"x".to_string()` / no-interp backticks
returning String (uses `String.from` or interpolated templates), which is why this
went uncaught.

## NARROWED to comptime_str-specific (2026-06-18)

`i32(42).to_string()` in the SAME `fn -> String` context WORKS in yo-self (prints
`42`) — so the comptime→runtime method retry + `to_string` + String-return path is
fine for `comptime_int → i32`. Only `comptime_str → str` fails. The retry lives in
`env.yo` (`is_comptime_receiver` block, ~2432): it maps the comptime receiver to
its runtime type via `_comptime_receiver_to_runtime` (→ `_resolve_str_type_from_env`
for comptime_str) and looks up methods on that runtime type's id. So the gap is
specifically: for a `comptime_str` receiver, the retry's resolved `str` type +
`to_string` lookup does NOT find/bind `str`'s `to_string` (std/imm/string.yo:726),
whereas for `comptime_int` the `i32`/`to_string` lookup succeeds. FIX target:
why `_resolve_str_type_from_env`'s `str` type id doesn't match where `str`'s
`to_string` is registered (or `str.to_string` isn't registered in the test's
import context, while `i32.to_string` is prelude-global). Instrument the
`is_comptime_receiver` retry for `to_string`+comptime_str: print `runtime_ty`,
`runtime_id`, and the method-hit count.

## Why it matters / priority

This is the root of the documented "effects backtick-arg edge"
(`issues/fixed/yo-self-sync-effect-codegen-unported.md`) — `raise(\`msg\`)`passes a
backtick String to a handler. Deprioritized vs unwind part 2 + parallelism for the
effects subsystem (effects are exercisable with`String.from`), but it is a
GENERAL `String`-codegen correctness bug worth fixing on its own.
