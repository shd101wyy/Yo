# `derive(ToString)` / `derive(Debug)` splice an unhygienic body — a file without `String` in scope compiles to `abort()`

**Status:** FIXED 2026-09-07
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

## Fix

`__derive_structural_body` now emits every literal as `"text".to_string()` — a
`str` literal plus a method call. A `str` literal introduces no identifier and
the method resolves through `impl(str, ToString(...))` by receiver type, so the
body has **no free identifier** except `self`, the `__v_*` arm bindings and the
`.`-prefixed variant tags, all of which are bound at the splice site.

Verified with **no** `String` import in the deriving file:

| shape | before | after |
| --- | --- | --- |
| `derive(P, Debug)` struct | rc=134, 1 FTT stub | `P(1, 2)` |
| `derive(Z, Debug)` empty struct | rc=134 | `Z()` |
| `derive(E, Debug)` payload-free enum | rc=134 | `E2.B` |
| `derive(P, ToString)` | rc=134 | `P(1, 2)` |
| `derive(E1, Debug)` enum w/ payload | `E1.NotFound(/tmp/x)` | unchanged |

The first route tried was a template literal (`` `P(${self.x.debug_string()})` ``),
which is also identifier-free, but `.to_expr()` cannot parse one — filed
separately as `issues/comptime-str-to-expr-cannot-parse-a-template-literal.md`.

Note `quote(...)` is only partially hygienic, which is worth knowing before the
next derive rule is written: a name **defined** at this module's top level does
resolve from the splice site, but an **imported** name (`String`) does not, and
nothing inside a `.to_expr()`-parsed string does. Measured, not assumed.

## Regression test

`tests/cli-cases/derive-render-without-string-import` — a `build run` fixture
that derives `Debug`/`ToString` in a file with no `String` import and asserts
all four rendered lines. Verified to FAIL on the pre-fix std (rc golden=0 run=1,
all four stdout lines missing) and PASS after.

The unit tree cannot host this: `tests/derive.test.yo` imports `String`, and
`yo check` reports OK on the broken program either way.

## Still open

`derive` swallowing a definition-time body failure — the FTT stub plus a green
`check` is why this survived a release. The `__attribute__((error(...)))` on the
stub does not fire at `-O2` even when the function is reached. That is the more
general defect and is NOT fixed here.
