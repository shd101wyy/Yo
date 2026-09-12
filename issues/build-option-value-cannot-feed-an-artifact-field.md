# A `build.option` value cannot feed any artifact field

**Status:** OPEN (found 2026-09-12). Belongs to the plan's B4 / §4.7 item
("`-D` options are unvalidated… values are untyped strings").

## Symptom

Every field of `build.executable` / `build.static_library` / `build.test` is
declared `comptime_str`, and `build.option` returns `comptime(str)`. The two do
not meet, so an option can configure NOTHING:

```rust
build :: import("std/build");
op :: build.option({ name : "op", description : "x", default : "square" });
lib :: build.static_library({ name : "probe-lib", root : op });
```

```
error[E0605]: Type mismatch for type member "root":
Expected: comptime_str
Got:   str
```

The same applies to `name`, `target`, a step's description, and to any value
DERIVED from an option (`if(op == "cube", "./src/cube.yo", "./src/lib.yo")`).
So the documented purpose of `-Dname=value` — "user-configurable build" — is
today limited to values the build file only compares, never to what it builds.

## The language rule underneath

A `fn` whose declared return type is `comptime_str` does not produce a
compile-time value at its call site; `comptime(T)` is the annotation that does.
Minimal proof:

```rust
f :: (fn(comptime(x) : comptime_str) -> comptime_str)(x);
g :: (fn(comptime(x) : comptime_str) -> comptime(str))(x);
a :: f("hello");   // error: Expected compile-time value for "a". Got runtime value.
b :: g("hello");   // fine
```

So `std/build.yo`'s `option :: (fn(comptime(config) : BuildOption) -> comptime(str))`
is correct as written, and re-declaring it `comptime_str` only moves the error
to the binding (`op :: build.option(...)` → "Got runtime value"). `comptime_str`
is satisfied by a literal or by a BUILTIN call — which is why
`(target : comptime_str) ?= __yo_build_target_host()` works while a wrapper's
return does not.

## Two candidate fixes

1. **Widen the config fields.** Declare the string fields of the build config
   structs so they accept a comptime-known `str` as well as a literal. Needs a
   check that `comptime(str)` is legal in a struct FIELD position, and it is
   seed-sensitive: the seed evaluates `std/build.yo` on every bootstrap
   `yo build` (see the AGENTS.md pitfall), so the change must be verified with
   the actual seed bundle before it lands.
2. **Coerce in the evaluator**: accept a comptime-KNOWN `str` value where
   `comptime_str` is expected. Broader, and it touches every `comptime_str`
   parameter in the language, not just the build API.

(1) is the smaller blast radius and is what the plan's §4.7 slice should try
first. Whichever lands, the gate is a cli-case building an artifact whose root
or name comes from `-Dname=value`, plus the dependency form
`-D<dep>.<opt>=value` — the runner already namespaces those
(`_namespaced_defines`, §4.5.2), and that plumbing has no end-to-end gate until
this is fixed.
