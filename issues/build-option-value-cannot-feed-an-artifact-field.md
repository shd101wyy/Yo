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

## Two candidate fixes — (1) is RULED OUT (probed 2026-09-12)

1. ~~**Widen the config fields**, declaring them `comptime(str)`.~~ Not
   possible: `comptime(...)` is a PARAMETER annotation and does not parse in a
   field type position —

   ```rust
   S :: struct((x : comptime(str)) ?= "a");
   // error[E0401]: Variable "comptime" not found … did you mean "Comptime"?
   ```

   And declaring the field plain `str` loses what the builtin needs: with
   `x : comptime_str` a literal argument keeps its compile-time value
   (`comptime_assert(t.x == "lit")` passes), while with `x : str` the field
   read is a runtime value and the same assert fails with
   `E1101: Expected bool value for "comptime_assert"`. The build builtins read
   their arguments through `ExprInfo.value` (`_build_arg_value`), so a `str`
   field would make every build call look like a trial evaluation.

2. **Accept a comptime-KNOWN value where `comptime_str` is expected.** This is
   the fix. The site is the struct-literal field check in
   `src/evaluator/calls/type.yo` (~`:317`), which for a comptime-only field
   type compares the argument's UNCONVERTED type against the field's:

   ```yo
   arg_type := if(
     _is_comptime_only_type_approx(member_element.ty),
     arg_info.ty,
     convert_comptime_type_to_runtime_type(arg_info.ty, env)
   );
   if(!are_types_compatible(arg_type, member_element.ty), { … throw … });
   ```

   `arg_info.value` is in hand right there, so the rule "a `str` whose value is
   a known `StrLit` satisfies `comptime_str`" can be applied at this site
   without touching `are_types_compatible`, whose callers have no value. The
   same argument value is what gets stored into `values(…)` afterwards, so the
   builtin sees the string.

   Scope to settle when implementing: whether the rule belongs only to the
   struct-literal site or also to plain `comptime_str` PARAMETERS (`f ::
   (fn(comptime(x) : comptime_str) …)`), and what the analogous rule is for
   `comptime_int` / `comptime_bool`.

The language rule is worth stating once in
`.github/instructions/yo-design.instructions.md` when this lands: `comptime_str`
means "known at compile time", and today it means "written as a literal". Whichever lands, the gate is a cli-case building an artifact whose root
or name comes from `-Dname=value`, plus the dependency form
`-D<dep>.<opt>=value` — the runner already namespaces those
(`_namespaced_defines`, §4.5.2), and that plumbing has no end-to-end gate until
this is fixed.
