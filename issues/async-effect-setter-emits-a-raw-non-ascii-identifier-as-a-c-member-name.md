# The async effect setter emits a raw non-ASCII identifier as a C member name

**Status: OPEN.** Found 2026-08-26 while reviewing D4 PR 3 (the `String`
byte-index flip). **Pre-existing and unrelated to D4** — it reproduces on the
seed compiler `yo 0.2.17`, whose `std` is still rune-indexed.

**Severity:** the emitted C does not compile. Loud, not silent — `yo compile`
fails with a `clang` error naming the member, so nothing wrong ships.

## Symptom

A struct-typed effect bundle with a non-ASCII **function-typed field** makes
`generate_future_effect_setter` (`src/codegen/exprs/async.yo`) write the field
name into the generated `set_effect` body verbatim, while the struct itself was
declared with the sanitized C name.

`tmp/repro.yo`:

```rust
open(import("std/string"));
open(import("std/fmt"));
Handler :: (fn(msg : String) -> i32);
MyEff :: struct(io : Io, é : Handler);
inner :: (fn(io : Io) -> Impl(Future(i32, MyEff)))(
  io.async((e) => {
    v := e.é(`hi`);
    return(v);
  })
);
work :: (fn(io : Io) -> Impl(Future(i32, MyEff)))(
  io.async((e) => {
    r := e.io.await(inner(io), e);
    return(r);
  })
);
main :: (fn(io : Io) -> unit)({
  (h : Handler) = (
    (m) -> {
      return(i32(7));
    }
  );
  eff := MyEff(io : io, é : h);
  r := io.await(work(io), eff);
  println(`r=${r}`);
});
export(main);
```

```console
$ yo compile tmp/repro.yo --release -o tmp/repro.bin
tmp/repro.bin.c:653:22: error: no member named 'é' in 'struct __yo_t0_struct'
  653 |     sm->__yo_param_0.é = value;
      |     ~~~~~~~~~~~~~~~~ ^
yo: error: compile: C compiler failed (exit 1) on tmp/repro.bin.c
```

The nested `io.await(inner(...), e)` is load-bearing: it is what makes the
injectable-effect-mapping loop run at all. Without it only the `__bundle`
branch is emitted and the file compiles.

## Why it is worth fixing

Non-ASCII identifiers are otherwise fully supported. This compiles and runs:

```rust
Pt :: struct(é : i32, 名前 : String);
名 :: (fn(x : i32) -> i32)((x + i32(1)));
```

So the effect setter is the outlier: everywhere else the codegen sanitizes an
identifier before it becomes a C name, and here it does not.

## Root cause

`generate_future_effect_setter` builds the assignment from
`EffectFieldMapping.access_path`, which `_visit_effect_struct_fields`
(`src/codegen/exprs/async.yo`) assembles as `` `${base_path}.${flabel}` `` from
the SOURCE field label. Every other consumer of a field label goes through the
codegen's C-name sanitizer first. The `strcmp(field, "é")` half is fine — that
is a string literal, not an identifier.

## Fix direction (not applied)

Run `flabel` through the same sanitizer the struct declaration used when
building `access_path`, leaving the `effect_label` (the `strcmp` key) as the
source spelling. The two are already distinct fields on `EffectFieldMapping`,
so the change is local.

## Regression coverage that already exists

`tests/codegen-bootstrap/effect_label_non_ascii.yo` covers the neighbouring
FUNCTION-typed-effect shape, where the label is a non-ASCII effect **type**
name and the access path is an ASCII capture field. That one compiles and runs
today (`r=7`), and it is the D4 ratchet for `_capitalize_last_segment`. This
issue is the struct-FIELD variant, which that file deliberately does not use.
