# `unit` in parameter or field position is emitted as C `void`

**Status:** OPEN
**Found:** 2026-08-24, while completing STD_API_AUDIT D3.8 (`ToString` for `unit`).
**Severity:** medium — `unit` is not usable as a value type argument, so
`ArrayList(unit)`, `HashMap(K, unit)`, tuples containing `unit`, and any
function taking a `unit` parameter fail at the C compiler.

## Symptom

The Yo side type-checks (`yo check` is green for every shape below); the failure
is always in the emitted C:

```
error: argument may not have 'void' type
error: 'void' must be the first and only parameter if specified
error: field has incomplete type 'void'
error: variable has incomplete type 'void'
error: expected expression          // an erased unit rvalue left an empty argument slot
```

## Measured boundary

Every row below was compiled with the branch binary (`yo compile <f> --release`)
on 2026-08-24. This is the whole boundary, not a sample.

| shape | result |
| --- | --- |
| `-> unit` return | ✅ works (emits C `void`) |
| `u := ()` local; `v := f()` where `f() -> unit` | ✅ works |
| `u.to_string()`, `println(u)` | ✅ works (fixed by the `inout`-unit ref-spill fix) |
| `Option(unit).Some(())` | ✅ works |
| `Result(unit, String).Ok(())` | ✅ works |
| `fn(x : unit) -> i32` (non-generic) | ❌ `argument may not have 'void' type` |
| closure `(fn(x : unit) -> i32)(...)` | ❌ same |
| generic `fn(generic(T : Type), x : T)` at `T = unit` | ❌ `'void' must be the first and only parameter` |
| `struct(a : i32, b : unit)` | ❌ `field has incomplete type 'void'` |
| tuple `(i32(1), ())` | ❌ `field has incomplete type 'void'` |
| `ArrayList(unit)` (`push`, `len`) | ❌ void param + void local + `expected expression` |
| `HashMap(String, unit)` | ❌ `field has incomplete type 'void'` |

The pattern: **`unit` works everywhere it is a C _statement_ or an erased
temporary, and breaks everywhere it becomes a C _declaration_** — a parameter,
a struct field, or a local of a generic-instantiated type.

Enum payloads are the interesting exception: `Option(unit)` and `Result(unit, E)`
already compile, so the enum-variant emitter has a working precedent for erasing
a unit payload that the struct/parameter emitters do not share.

## Reproducers

```rust
// unit-typed parameter — no generics involved
takes :: (fn(x : unit) -> i32)(i32(7));
main :: (fn() -> unit)({ assert(takes(()) == i32(7), "direct unit param"); });
```

```rust
// unit-typed field
S :: struct(a : i32, b : unit);
main :: (fn() -> unit)({ s := S(a : i32(1), b : ()); });
```

```rust
// generic container at T = unit
xs := ArrayList(unit).new();
xs.push(());
```

Emitted C for the generic case (`ArrayList(unit).push`):

```c
static inline __yo_t9 yo_id_4020_..._push(__yo_t7* self, void value) { ... }
//                                                       ^^^^^^^^^^
```

## Root cause (shape of it)

The Yo→C type mapping returns `void` for `unit`. That is correct in return
position and harmless where the codegen already erases the value, but nothing
skips the *declaration* in parameter lists, struct-field lists, and local
declarations, and nothing drops the matching argument at the call site — so an
erased unit rvalue can also leave an empty slot in an argument list
(`expected expression`).

Two coherent fixes exist:

- **A — full erasure (Rust-style ZST):** unit never appears in the C. Parameters
  and fields are dropped; a unit-typed argument expression is still evaluated for
  its side effects but not passed. Requires parameter emission and argument
  emission to stay in lockstep, including for function pointers (closures, `dyn`
  vtables, async state machines), where both sides of an ABI must agree.
- **B — concrete 1-byte representation:** `unit` gets a real C type, so
  parameters/fields/locals are ordinary values. Cheap and local, but raises the
  question of what `-> unit` returns become, since they emit `void` today.

## Not blocking

`ToString` for `unit` (STD_API_AUDIT D3.8) is complete without this: `().to_string()`
and `println(())` work. `tests/fmt.test.yo` ("Test unit ToString") carries a note
pointing here, and deliberately does **not** exercise a container of `unit`.
