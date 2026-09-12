# Two externs with the same signature emit only ONE prototype

**Status:** FIXED (2026-09-12)
**Area:** codegen — extern function collection / declaration emission
**Surfaced by:** a build fixture that declares two independent static-library
artifacts `alpha` and `beta` and calls both from one program — so the program
declares two `extern("Yo", … : (fn(n : i32) -> i32))` symbols of ONE type.

## Symptom

```
error: call to undeclared function 'alpha'; ISO C99 and later do not support
       implicit function declarations [-Wimplicit-function-declaration]
```

at `-O0`, and — worse — a *silent pass* at `--optimize 2`, where the emitted C
compiled and linked with only a warning.

## Minimal reproducer

```rust
pragma(Pragma.AllowUnsafe);
{ println } :: import("std/fmt");
extern("c", toupper : (fn(c : i32) -> i32));
extern("c", tolower : (fn(c : i32) -> i32));
main :: (fn() -> unit)({
  println((unsafe(toupper(i32(97))) + unsafe(tolower(i32(66)))).to_string());
});
export(main);
```

`yo compile … --emit-c --skip-c-compiler` emits exactly one prototype:

```c
extern int32_t tolower(int32_t c);
```

`toupper` is called with no declaration at all.

## Root cause

`_register_extern_fn_callee` (`src/codegen/functions/collection.yo`) registered
every extern callee into `CodeGenContext.extern_functions`, a
`HashMap(String, CodegenExternFnEntry)`, **keyed by `type_key(cei_ty)`**:

```yo
context.register_extern_function(type_key(cei_ty), cei_ty, c_name, get_c_include_for_extern(c_name.clone()));
```

`toupper` and `tolower` have the *same type* — `(fn(i32) -> i32)` — so they
share a type key and the second registration overwrote the first. The map holds
symbols, and a type does not identify a symbol.

Both downstream consumers iterate `.values()` only —
`generate_function_declarations` (`src/codegen/functions/declarations.yo`, which
emits the prototypes) and the `c_include` collector
(`src/codegen/c/collection.yo`) — so nothing ever looked the entry up *by* that
key. The collision therefore had no purpose and one pure effect: dropping
prototypes, and dropping the `c_include` of whichever extern lost the race.

This is another instance of the pattern in
`issues/fixed/ts-registry-lookups-mis-port.md`: TS read the entry off the
function *value*, and the Yo port replaced that with a global table keyed by
type key.

## Fix

Key the registry by the C symbol name:

```yo
context.register_extern_function(c_name.clone(), cei_ty, c_name, get_c_include_for_extern(c_name.clone()));
```

A symbol name identifies the function. Two declarations of the same symbol still
collapse to one entry, which is exactly right.

## Why -O2 hid it

`src/main.yo`'s optimized arm passed `-Wno-everything` and then re-enabled a
short list of warnings, including a bare `-Wimplicit-function-declaration` —
which *downgraded* clang's default error back to a warning. A call with no
prototype truncates its return value to `int` and default-promotes its
arguments; it is never benign. That flag is now
`-Werror=implicit-function-declaration`, matching what the `-O0` arm already
gets from clang's defaults.

## Regression test

`tests/extern_unsafe_wrap.test.yo` — "two externs with the same signature both
get a prototype". Verified red before the fix (the batch's C compile fails with
`call to undeclared library function 'toupper'`) and green after.
