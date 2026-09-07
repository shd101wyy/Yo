# `derive(ToString)` / `derive(Debug)` splice an unhygienic body — a file without `String` in scope compiles to `abort()`

**Status:** open
**Found:** 2026-09-07, while checking the `derive` arity in `std/fmt/to_string.yo`'s doc comment
**Severity:** silent miscompile — `yo check` reports "evaluator OK", the binary aborts with no message

## Symptom

```rust
{ println } :: import("std/fmt");
P :: struct(x : i32, y : i32);
derive(P, ToString);
main :: (fn() -> unit)(println(P(x : i32(1), y : i32(2)).to_string()));
export(main);
```

```
$ yo check r1.yo          # → evaluator OK
$ yo compile r1.yo --optimize 2 -o r1.out && ./r1.out
$ echo $?
134                       # SIGABRT, no output, no diagnostic
```

Adding `{ String } :: import("std/string");` to the file makes it print `P(1, 2)`.

## Root cause

`__derive_structural_body` (`std/fmt/to_string.yo:588`) builds the impl body as a
comptime **string** which is then parsed by `.to_expr()`:

```
((((String.from("P(") + self.x.debug_string()) + String.from(", ")) + self.y.debug_string()) + String.from(")"))
```

`.to_expr()` parses fresh source, so the splice carries **no hygiene**: the name
`String` is resolved in the *deriving file's* module scope, not in
`std/fmt/to_string.yo`'s. With `YO_DEBUG_SWALLOW=1`:

```
[var-miss] name=String env_module=file:///.../r1.yo frames=6
[anon-swallow] error[E0401]: Variable "String" not found.
```

The def-time failure is swallowed, so the emitted C is an FTT stub:

```c
__attribute__((error("yo: the body of fn_yo_id_7585 failed to transpile — its
  definition-time evaluation failed and was swallowed ...")))
static inline __yo_t1 fn_yo_id_7585(__yo_t0* self) {
  abort(); /* untranspilable body in a value-returning fn */
}
```

The `__attribute__((error(...)))` does **not** fire at `-O2` even though the function
is reached, so nothing surfaces until runtime.

## Scope

- **Pre-dates D15.** `derive(ToString)` is affected identically; `derive(Debug)`
  inherits it because both call `__derive_structural_body`.
- Affects the struct branch, the payload-free enum branch and the payload enum
  branch — every branch emits `String.from(...)`.
- Invisible in `tests/derive.test.yo` because that file imports `String`, as does
  every std module that derives. Only a user file that renders a derived type
  *without* naming `String` hits it.

## Candidate fix (verified by hand)

Emit the body from backtick literals and `${}` interpolation, which need no
`String` binding in the caller's scope:

```rust
impl(P, Debug(debug_string : ((self) -> `P(${self.x.debug_string()}, ${self.y.debug_string()})`)));
```

Verified: compiles and prints `P(1, 2)` in a file with **no** `String` import.
This also removes the `+`-chain, so `__derive_structural_body` gets simpler.

Two follow-ups worth separating:
1. The hygiene bug itself (this issue).
2. **`derive` should not silently swallow a def-time body failure** — the FTT stub
   plus a green `check` is the reason this survived. That is the more general defect.

## Tests to add

`tests/derive.test.yo` cannot cover it (it imports `String`). Needs a case in
`tests/cli-cases/` — a `build run` fixture whose source omits the `String` import
and whose expected stdout is the rendered value, so the abort is caught as a
runtime diff rather than a compile-time pass.
