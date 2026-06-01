# Instantiating a generic with an impl + object-type arg re-calls the constructor with an `Unknown` arg → nested-generic field fails

## Status

Open — **root cause precisely localized** to a 4-line repro. This is the
`std/encoding/html.yo` blocker (`HashMap(String,String)`), the head of the
generic-method-resolution cascade. The earlier `type_arguments` /
`self-dispatch` work (`issues/self-dispatch-loses-type-args.md`) was a related
but distinct layer; THIS is why `HashMap(String,String)` fails to even
instantiate as a type.

## Minimal reproducer (no std internals — just `String`)

```rust
pragma(Pragma.AllowUnsafe);
Inner :: (fn(comptime(A) : Type, comptime(B) : Type) -> comptime(Type))(struct(x : A, y : B));
Outer :: (fn(comptime(K) : Type, comptime(V) : Type) -> comptime(Type))(object(f : ?*(Inner(K, V))));
impl(forall(K : Type, V : Type), Outer(K, V), make : (fn() -> usize)(usize(0)));
T :: Outer(String, String);
export(T);
```

`yo-self-bin check` → `Error: (1) Expected type for element, got A`
(`Inner`'s `x : A` field, with `A` = `Unknown`). TS `yo-cli check` → OK.

## Bisection (each row flips ONE thing; FAIL/OK by **exit code**)

| Variant                                      | Result   |
| -------------------------------------------- | -------- |
| `Outer(i32, i32)` (primitive args)           | **OK**   |
| `Outer(String, i32)` / `Outer(i32, String)`  | **OK**   |
| `Outer(String, String)`, **no impl block**   | **OK**   |
| `Outer(String, String)`, **with impl block** | **FAIL** |

So the trigger is the conjunction of THREE things:

1. The outer generic has a **field referencing a nested generic** (`f : ?*(Inner(K,V))`).
2. There is an **impl block** for the outer generic.
3. It is instantiated with an **object / reference-semantics type** argument
   (`String`). Primitive args (`i32`) never trigger it.

The method body is irrelevant (an empty `usize(0)` body still fails) — only the
impl's _presence_ matters. `where`-clauses are NOT required.

## Root cause (instrumented)

Instrumenting the param-binding loop (`function.yo`) + the field-throw
(`field.yo`) shows: there is a **second `Outer(String, …)` call** whose argument
expression `String` evaluates to **`UnknownVal`** (not the `String` type):

```
FNDBG K=Unknown: callee=Outer arg0=String body=object(f : ?*(Inner(K, V)))
FLDDBG field-throw: label=x te=A
```

So `Outer`'s param `K` binds to `Unknown`; its body `object(f : ?*(Inner(K,V)))`
then evaluates `Inner(Unknown, …)`, whose `x : A` field can't resolve `A` → the
error. The phase flags on that call are all off
(`ctfe_analysis=N validating_def=N force_ct=N`), so it is a **normal** eval, not
CTFE-capability analysis.

The _first_ `Outer(String,String)` call (the user's `T :: …`) evaluates `String`
→ a proper `TypeVal` and takes the memoized comptime-fn path (works). The
**second** call — triggered only when an impl is present AND the arg is an
object type — re-invokes `Outer` with an arg that resolves to `UnknownVal`.

## Where to look next (the fix)

Find what re-invokes the type constructor during instantiation of an
**object-type** generic that has an impl. Leading candidates:

- The **impl/type-trait-method attachment** path: when `Outer(String,String)` is
  instantiated and an impl `impl(forall(K,V), Outer(K,V), …)` exists, the
  evaluator may re-instantiate the receiver to attach/match methods, passing
  reconstructed args that resolve to `Unknown`.
- The **RC/drop analysis** for reference-semantics types
  (`auto_derive_traits_for_struct_type` / `type_contains_rc_type`): only object
  args make `Inner(String,String)` contain an RC type, which could trigger a
  re-walk/re-instantiation of the field with abstract `K`.

The fix is to ensure that re-invocation passes the concrete type arguments (or
does not re-evaluate the field types with `Unknown`-valued params). The
`i32`-works / `String`-fails split is the key discriminator to follow.

## REFINEMENT (corrected, simpler) — it is an RC-field trigger, NOT impl

The impl block and nested generic in the repro above are NOT required. The
minimal trigger is much simpler:

```rust
Outer :: (fn(comptime(K) : Type, comptime(V) : Type) -> comptime(Type))(struct(g : K));
T :: Outer(String, i32);
export(T);
```

→ `Error: (1) Expected type for element, got K`.

Bisection (FAIL/OK by **exit code** — note: a `grep … | tail -1` harness is
unreliable here because it matches the prelude's "evaluator OK" line):

| Variant (field `g : K`, NO impl)                                 | Result   |
| ---------------------------------------------------------------- | -------- |
| `Outer(i32, i32)`                                                | OK       |
| `Outer(MyVal, MyVal)`, `MyVal :: struct(n : i32)` (value struct) | OK       |
| `Outer(String, i32)` — `String` in K (the field-used param)      | **FAIL** |
| `Outer(i32, String)` — `String` in V (not used by the field)     | OK       |
| field `g : V`, `Outer(i32, String)`                              | **FAIL** |
| field `g : V`, `Outer(String, i32)`                              | OK       |

**Precise trigger:** the type-param a field's type uses is bound to a
**reference-semantics / RC type** (`String`). A value type (`i32`, a plain
`struct`) in the same position never triggers it. So the second
`Outer(<param>→Unknown)` constructor re-call is driven by **RC/drop analysis**
of a generic instantiation whose field is RC — `auto_derive_traits_for_struct_type`
/ `type_contains_rc_type` / RC-function attachment re-evaluates the constructor
(or its field types) with the type-param bound to `UnknownVal`. The fix is to
have that RC path use the concrete instantiation (not re-evaluate with abstract
params). The `i32`-OK / `String`-FAIL split (value vs RC) is the discriminator.

## FURTHER REFINEMENT — the discriminator is `String`'s specific shape

Disambiguating "reference-semantics" vs "has-impls" vs "newtype" (all by exit
code, field `g : K`, no impl on Outer):

| `K` =                                                       | Result   |
| ----------------------------------------------------------- | -------- |
| `i32` (primitive)                                           | OK       |
| user `struct(n : i32)` (value)                              | OK       |
| user `object(n : i32)` (reference-semantics, no impls)      | OK       |
| user value-struct WITH an impl                              | OK       |
| user `newtype(v : i32)` (no impl)                           | OK       |
| `String` (`newtype(_bytes : Option(ArrayList(u8)))` + impl) | **FAIL** |

So none of {reference-semantics, has-impls, newtype} ALONE triggers it — only
`String`'s full shape does: a **newtype wrapping an RC-containing field
(`Option(ArrayList(u8))`) that also has an impl**. The next trace should
reproduce that exact shape (a user newtype wrapping `Option(ArrayList(u8))` with
an impl) and find which analysis (RC-function attachment / acyclic / drop, which
recurse through the newtype's RC content) re-instantiates the enclosing generic
constructor with the type-param bound to `UnknownVal`.

## DEFINITIVE MINIMAL REPRO + hypothesis elimination (trace session 2)

The smallest reproducer is just two lines:

```rust
S :: (fn(comptime(K) : Type) -> comptime(Type))(struct(g : K));
T :: S(String);     // FAIL: "Expected type for element, got K"
```

Confirmed by **exit code** (write→check, no grep-tail pitfall):

| `K` =                                                                                                                | Result   |
| -------------------------------------------------------------------------------------------------------------------- | -------- |
| `i32`, `bool`, user `struct`, user `object`, user `newtype`, `Option(i32)`, `ArrayList(u8)`, `Option(ArrayList(u8))` | **OK**   |
| `String`                                                                                                             | **FAIL** |

Also required: `K` must be **used in the struct body** (`struct(g : i32)` with K
unused → OK), and the body must **build a struct** (`idt(String)` where the body
just returns the param `X` → OK). So: _building `struct(g : K)` where `K` is
bound to `String` re-invokes `S` with `K = Unknown`, and the re-called body's
field `g : K` fails._

**`String` is genuinely unique** — not its structure (a hand-written
`newtype(Option(ArrayList(u8)))` + impl does NOT reproduce), not the types it
wraps (`ArrayList(u8)` / `Option(ArrayList(u8))` as `K` are fine), not
reference-semantics / has-impls / newtype individually. It is tied to `String`'s
exact prelude definition (`std/string/string.yo`: a newtype with MANY impls —
`Add`, `Eq`, `Ord`, `ToString`, an `Iterable`/iterator impl with `ref(self)`,
etc.).

**Hypotheses ELIMINATED by instrumentation** (breadcrumb global set at suspect
entries, read at the field-throw):

- **NOT RC/drop auto-derivation**: `rc_derive_active = N` at the throw (a depth
  counter around `auto_derive_traits_for_struct_type`).
- **NOT generic-impl matching / method resolution**: `crumb = none` at the
  throw (breadcrumbs in `try_match_generic_impl`,
  `find_methods_from_generic_impls`, `get_type_trait_methods_by_name_from_env`
  never fired on the failing path).
- **NOT CTFE-capability analysis / definition validation**: those ctx flags are
  all off on the failing call.

So the spurious second `S(String→Unknown)` call happens during **plain
evaluation**, from a path none of the above covers. Next trace: a breadcrumb in
**every** `evaluate_*` dispatch (or `evaluate_struct_type` + the trait-check
helpers `type_implements_send`/`type_implements_acyclic` invoked on the `String`
field) to catch the re-entry, and determine what about `String`'s specific
prelude TypeVal (vs an identical-structure local newtype) drives it.

## Validation

- The repro above must pass under `yo-self-bin check`.
- `T :: HashMap(String, String)` (importing std) must pass.
- `std/encoding/html.yo` must move past `hash_map.yo:59`.
- `check ./std` per-file: only html.yo may change; regressors green.
