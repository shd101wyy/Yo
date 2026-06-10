# Instantiating a generic with an impl + object-type arg re-calls the constructor with an `Unknown` arg → nested-generic field fails

## Status

**RESOLVED — this was a PHANTOM (trace session 5).** The "2-line repro" below
was an **invalid reproducer**: the scratch file never did
`open(import("std/string"))`, so the identifier `String` was simply **not bound
in scope**. yo-self's identifier evaluator has a _soft fallback_ (returns
`UnknownVal` of `t_unit()` instead of throwing "Variable not found", see
`yo-self/evaluator/exprs/identifer_and_operator.yo` ~line 147), which **masked**
the missing binding: `String` → `UnknownVal` → param `K` bound to a non-type →
the struct field `g : K` then failed with "Expected type for element, got K".

`i32` "worked" only because `i32` is a **builtin keyword** resolved on the
fast-path _without_ env lookup (`identifer_and_operator.yo` ~line 71), so it
never hit the not-found fallback. That is the entire `i32`-OK / `String`-FAIL
split that misled five trace sessions and ~21 builds. There was **never** a
"second constructor call" — the lingering single-global breadcrumb created that
illusion; trace session 5's _sequential_ prints (read in program order, not
last-value) showed exactly ONE `S` call, failing inside its single body eval.

**Verified with proper imports:**

```rust
open(import("std/string"));
S :: (fn(comptime(K) : Type) -> comptime(Type))(struct(g : K));
T :: S(String);                              // PASS (exit 0)
```

```rust
open(import("std/string"));
{ HashMap } :: import("std/collections/hash_map");
T :: HashMap(String, String);                // PASS (exit 0)
```

So `HashMap(String,String)` **instantiates fine** under `yo-self-bin check`.
The `type_arguments` / self-dispatch work (`issues/self-dispatch-loses-type-args.md`)
stands on its own; it was never the cause of this symptom.

**The real `std/encoding/html.yo` blocker is now a DIFFERENT error:**
`Expected compile-time value for "bucket_size"` — `bucket_size :: sizeof(Bucket(K, V))`
in `std/collections/hash_map.yo:59` evaluates to a _runtime_ value instead of a
comptime one. Tracked separately in `issues/sizeof-not-comptime-in-generic-method.md`.

**Lesson / latent footgun:** the not-found soft fallback in the identifier
evaluator silently degrades a missing binding into `UnknownVal`. TS throws
"Variable not found" here. The fallback exists to tolerate prelude operator-trait
names (`==`, …) during preload, but it also swallows genuine scope errors and
turns them into baffling far-downstream type failures. Consider narrowing it to
only the operator-name cases (or logging) so future missing-binding bugs surface
at the source.

---

_Original (pre-resolution) investigation notes preserved below for the record._

## (HISTORICAL) Status

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

## TRACE SESSION 3 (broad breadcrumb) — re-call is in the struct-build region

Added a breadcrumb global (`dbg_set_crumb`/`dbg_get_crumb` in value.yo) set at
the entry of many suspects (struct.yo `evaluate_struct_type`, field.yo
`evaluate_type_field`, helper.yo `try_to_call_function_with_arguments` /
`create_specialized_function_inline`, plus the earlier RC / generic-impl ones),
printed at the `K=Unknown` `S` call. Results on `S :: …(struct(g : K)); T :: S(String)`:

- crumb = **`field`** → then refined to **`field_te:*(T)`** (the breadcrumb was
  set right before evaluating a field's type expr, and the active expr at that
  point was a `*(T)` raw-pointer type with an **abstract** `T` — i.e. a generic
  body being evaluated with `T` unbound, as in ArrayList's internal buffer
  field, reached via String → `Option(ArrayList(u8))`).
- After adding a reset (`dbg_set_crumb("field_after_te")` right after the
  te-eval), the `K=Unknown` call showed crumb = **`field_after_te`** — i.e. the
  re-call is **after** the field's type-expr eval, in the struct-finalization
  region (and the global crumb lingers there).

**Conclusion of session 3:** the spurious `S(K=Unknown)` re-call lives in the
**struct-build → field-eval → finalization** region (NOT RC-derive, NOT
generic-impl matching, NOT CTFE), and is reached while resolving the
representation of a `String`-typed field (which transitively involves a generic
body with an abstract pointer `*(T)`). **A single "last setter" breadcrumb is
too coarse to pin the exact caller** — it lingers across struct finalization.
The next trace needs a **push/pop call-stack breadcrumb** (a `String` stack
pushed on entry / popped on exit of each candidate, printed at the `K=Unknown`
call) to capture the actual call chain, OR direct instrumentation of
`evaluate_struct_type`'s post-field steps + whatever resolves a newtype field's
representation.

## TRACE SESSION 4 (call-stack crumb) — re-call is in the `::`/`:=` binding's downstream

Walked a single-global breadcrumb (`dbg_set_crumb`/`dbg_get_crumb`) downstream
through the pipeline, set at fine points and printed at the `K=Unknown` `S`
call. The crumb advanced, in order:

`field` → `field_te:*(T)` → `field_after_te` → `sf_typeoftype` → `sf_done`
(end of `evaluate_struct_type`) → `cf_return` (end of the first `S`'s
`evaluate_comptime_fn_call`) → `ia_postrhs` → `ia_after_dup` →
`ia_check_predef` (all inside `evaluate_initialization_assignment`, the
`::`/`:=` binding handler).

So the spurious **second `S(String→Unknown)` call happens during the
`T :: S(String)` binding's DOWNSTREAM processing** — after the RHS eval (line 209) and the dup step, in the type-inference / comptime-modifier-check region
(`initialization_assignment.yo`, after `set_expr_as_needs_to_call_dup`, around
the `has_predefined_type` check). It is NOT the binding's own RHS eval (that's
call #1, `K=String`), NOT `export` (fails without it), NOT the annotated
`synthesize_expr_and_type` branch (`ia_synth_branch` never fired), NOT
`convert_comptime_type_to_runtime_type` (`ia_before_convert` never fired).

**Limitation:** a single "last-setter" global breadcrumb **cannot pin the exact
line** — it lingers across the binding's tail/return, so each added crumb just
moves the apparent location one region downstream. Pinning the exact re-eval
needs a **push/pop call-STACK** (push on entry / pop on every return of each
candidate — non-trivial because of Yo's early-`return`s), or instrumenting the
specific binding-tail helpers (`require_expr_not_consumed`,
`set_expr_as_needs_to_call_dup`, the comptime-modifier checks
`type_requires_comptime_modifier`/`type_prohibits_comptime_modifier`, and the
final `add_variable_to_env`) to find which one re-evaluates the RHS expr
`S(String)` in an env where `String` resolves to `UnknownVal`.

**Net (5 trace sessions, ~21 builds):** the years-old html.yo knot is reduced
to a 2-line repro and localized to _the binding handler re-evaluating the RHS a
second time, in its post-RHS/post-dup tail, with `String` resolving to Unknown_.
RC, generic-impl matching, CTFE, `type_of_type`, struct-build, comptime_fn, and
`export` are all ruled out.

## Validation

- The repro above must pass under `yo-self-bin check`.
- `T :: HashMap(String, String)` (importing std) must pass.
- `std/encoding/html.yo` must move past `hash_map.yo:59`.
- `check ./std` per-file: only html.yo may change; regressors green.
