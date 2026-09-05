# A `comptime_str` passed where `String` is declared passes `check` and emits invalid C

**Found**: 2026-09-05, while writing the regression tests for
`issues/fixed/url-parse-validates-no-characters-so-a-crlf-url-splits-the-http-request.md` —
a helper declared `label : String` was called with a plain `"..."` literal.
**Status**: OPEN. Measured against `develop` at v0.2.24.

**Class**: missing rejection / invalid codegen. Exactly the shape of **C19**
(`issues/fixed/`, "reject a C int passed where i32 is declared"): the evaluator
accepts a type it should reject, and the error surfaces as a C compiler
diagnostic pointing at generated code the user never wrote.

## Reproducer

```rust
open(import("std/string"));
{ assert } :: import("std/assert");
{ println } :: import("std/fmt");
_helper :: (fn(src : String, at : usize, label : String) -> unit)({
  assert(src.len() > at, label);
});
main :: (fn() -> unit)({
  //                                              vvvvvvvvvvvvvvvvvvv  comptime_str, not String
  _helper(String.from("http://exa mple.com/"), usize(10), "raw space in host");
  println(`ok`);
});
export(main);
```

`yo check` is clean:

```
$ yo check castbad.yo --std-path ./std
check: parsed 8 top-level exprs
check: invoking evaluate_anonymous_module_begin_exprs
check: castbad.yo — evaluator OK
```

`yo compile` then fails inside the C compiler:

```
$ yo compile castbad.yo --std-path ./std --optimize 2 -o castbad
castbad.c:1551:69: error: used type '__yo_t8' (aka 'struct __yo_t9_struct')
                          where arithmetic or pointer type is required
1 error generated.
```

The emitted line casts a struct-typed value with a C cast expression:

```c
yo_id_10636((__yo_t9)(_file____User_temp_15804), (size_t)(10ULL),
            (__yo_t9)((__yo_str){ .ptr = (const uint8_t*)"raw space in host", .len = 17 }));
```

`(__yo_t9)(...)` is a cast to a **struct** type, which C does not allow.

Changing the argument to a backtick literal (which IS a `String`) compiles and
runs:

```rust
_helper(String.from("http://exa mple.com/"), usize(10), `raw space in host`);
```

```
$ ./castrepro
ok
```

## Why it matters

The two spellings look interchangeable and are not — `` `...` `` is `String`,
`"..."` is `comptime_str` (`.github/skills/yo-syntax/syntax-cheatsheet.md:111`).
The mistake is easy to make and common in test helpers, where messages are
habitually written with double quotes because `assert`'s own message parameter
accepts them. What the author gets is not a type error naming the argument but
a clang error naming a generated identifier, hundreds of lines into a file they
did not write — the diagnostic gives no path back to the call site.

It also means `yo check ./std` and `yo check ./src` cannot be trusted to catch
this class, so it survives until someone runs a full compile.

## Where to look

The parameter-binding compatibility check that C19 tightened —
`src/evaluator/calls/` — accepts `comptime_str` for a declared `String`
parameter. Either reject it at check time with a message naming the argument
and both spellings (the C19 shape, and the one this issue asks for), or, if an
implicit widening is intended, make codegen emit the real conversion
(`String.from`'s lowering) instead of a C cast. It must not stay in the current
state, where the evaluator says yes and codegen emits code that cannot compile.

Note the reverse direction (a `String` where `str`/`comptime_str` is declared)
should be checked at the same time — the cheatsheet records that a
double-quoted literal does not concatenate with a `String` variable, so the two
directions are already known to be distinct types with no implicit bridge.

## Regression test

A `tests/cli-cases/` golden is the right home, since the assertion is about a
compile FAILING with a specific diagnostic: a `compile` case whose
`expected_rc` is non-zero and whose `stdout_keep_match` names the argument and
the two types. Plus an over-rejection canary — a call passing a backtick
literal, and one passing `String.from("...")` — that must keep compiling.
