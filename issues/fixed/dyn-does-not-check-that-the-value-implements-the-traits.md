# `dyn(x)` never checks that `x`'s type implements the Dyn's traits

**Status: FIXED** 2026-09-05 (C69). Root cause: `evaluate_dyn_value` had **no
trait-satisfaction check at all** on the coercion path — `_resolve_dyn_trait_values`
pushed a `.None` field for any required member the concrete type does not
implement, and codegen's two emitters then disagreed about that `.None` (the
wrapper emitter SKIPS the method, the vtable emitter names it anyway), so a
plain type error surfaced as a C-level undeclared identifier. The fix ports the
check TS already had (`values/dyn.ts:543`, "Required trait X is not implemented
by type Y") as `_require_dyn_traits_implemented` in
`src/evaluator/values/dyn.yo`, asking `type_implements_trait_bool` per required
`TraitT` on both the executing and the validating path.

**Found:** 2026-09-04, measuring the `error`/`assert` row of the std API audit
(the row's `derive(Error)` item asks what `impl(_, Error())` actually buys — the
answer was: nothing, the compiler never read it).
**Severity:** api-lie, with a crash face. A plain type error was reported as an
undeclared C identifier, and the documented rule "an error type is a real enum
implementing `Error()`" (`.github/instructions/yo-design.instructions.md`)
was unenforced — so `impl(_, Error())` was decorative.

## Symptom 1 — a type with NO impls at all is accepted as an `AnyError`

```rust
{ AnyError } :: import("std/error");
open(import("std/string"));
open(import("std/fmt"));

NoTraits :: enum(Boom);          // no ToString, no Error

main :: (fn(io : Io) -> unit)({
  (e : AnyError) = dyn(NoTraits.Boom);
  match(e.source(), .Some(_) => println(`some`), .None => println(`none`));
});
export(main);
```

**Before:** `yo check` — clean (rc=0). `yo compile … --optimize 2`:

```
d2.out.c:538:36: error: use of undeclared identifier '__yo_wrap___yo_t8___yo_t0_to_string'
1 error generated.
yo: error: compile: C compiler failed (exit 1) on d2.out.c
```

The emitted C showed both halves of the mechanism — the wrapper was skipped with
a comment, the vtable still pointed at it:

```c
/* Warning: Module field to_string is not a function value */      // line 524
…
  .to_string = (__yo_t4 (*)(void*))__yo_wrap___yo_t8___yo_t0_to_string,   // line 538
```

**After:** rejected by the evaluator, at `yo check` time:

```
error: Type NoTraits does not implement the trait Error required by dyn(Error + ToString).
```

## Symptom 2 — a `ToString`-only type is a fully working `AnyError`

```rust
{ AnyError, Error } :: import("std/error");
open(import("std/string"));
open(import("std/fmt"));

NoErrImpl :: enum(Boom);         // ToString, but NO impl(NoErrImpl, Error())
impl(NoErrImpl, ToString(to_string : (fn(inout(self) : Self) -> String)(`boom`)));

main :: (fn(io : Io) -> unit)({
  (e : AnyError) = dyn(NoErrImpl.Boom);
  println(`${e}`);
  match(e.source(), .Some(_) => println(`some`), .None => println(`none`));
  match(Type.impls(NoErrImpl, Error), true => println(`impls Error: true`), false => println(`impls Error: false`));
});
export(main);
```

**Before:** compiled, ran, rc=0:

```
boom
none
impls Error: false
```

`AnyError` is `Dyn(Error)` (`std/error.yo:16`), yet a type the compiler itself
said does NOT implement `Error` was stored in one and dispatched through it. The
`source()` slot resolved to the trait's `?=` default, so nothing even looked
wrong at runtime.

**After:**

```
error: Type NoErrImpl does not implement the trait Error required by dyn(Error + ToString).
```

## Root cause

`evaluate_dyn_value` (`src/evaluator/values/dyn.yo`) builds the Dyn's trait
values through `_resolve_dyn_trait_values`, which — per required trait, per
method label — searches the concrete type's registered trait methods, then falls
back to the trait's `?=` default, and finally pushes whatever it got:

```rust
field_vals.push(resolved_field);        // src/evaluator/values/dyn.yo
```

`resolved_field` is an `Option(EvalValue)`; a method the concrete type does not
implement (and that has no trait default) yields `.None`, and that `.None` was
pushed without complaint. There was no trait-satisfaction check anywhere on the
coercion path — `grep -nE "impls|does_type_implement|satisf|check_trait|trait_impl"
src/evaluator/values/dyn.yo` returned nothing.

Codegen then diverged on that `.None`:

- the wrapper emitter skips the method and writes a comment
  (`src/codegen/functions/dyn.yo` — `/* Warning: Module field ${label} is not
  a function value */`);
- the vtable emitter names the wrapper unconditionally for every trait slot whose
  first parameter is `self`.

Hence `use of undeclared identifier '__yo_wrap_…_to_string'`.

Note the missing check is a PORTING GAP, not a design choice: the TypeScript
reference rejects both symptoms right here —
`Required trait ${typeToString(requiredTraitType)} is not implemented by type
${typeToString(valueType)}.` (`src/evaluator/values/dyn.ts:543` at tag
`src-attic-final`), reached by searching the concrete type's `trait.fields` for a
trait value compatible with the required one. yo-self's `TypeValue` carries no
`trait` slot, so that search became the type-id-keyed side table
(`g_type_trait_registry`, written by `register_type_trait_value` on every
concrete `impl(T, Trait(...))`) — and the port simply never made the query.

Someone noticed the gap and left it as a comment instead of a test:
`tests/dyn.test.yo:110` — `// Dog :: struct(); // This should give error working
with dyn.` That comment is now the two `comptime_expect_error` tests.

## The fix

`_require_dyn_traits_implemented` (`src/evaluator/values/dyn.yo`), called from
BOTH `evaluate_dyn_value` paths — the executing path and the
validating/non-executing path that `yo check` and every fn-body evaluation take.
For each required trait of the target `Dyn`:

- **only nominal `TraitT` requirements are checked.** A `FnTraitT` requirement is
  a dyn'd CLOSURE, which IS its own implementation — there is no registry impl to
  find (the arm `_resolve_dyn_trait_values` already special-cases). Every other
  required-type shape is not a nominal trait.
- the question asked is `type_implements_trait_bool`, which reads the same
  registry TS's `trait.fields` search reads AND additionally answers through
  generic impls, the builtin markers and `Dyn`/`SomeT` constraint sets — i.e. it
  is strictly MORE permissive than TS's mechanism, which is the safe direction
  for a new rejection.
- the payload is unwrapped through `_unwrap_box_for_method_lookup` first, so the
  bound is decided on the UNBOXED concrete: `dyn(box(i32(42)))` and the auto-box
  path both arrive as `Box(i32)` while the impl is registered against `i32`.
- `Dyn(Error)`'s required set is `(Error, ToString)` — `evaluate_dyn_type`
  expands trait self-constraints (`where(Self <: ToString)`) into
  `required_trait_types` — so both are checked, which is what makes symptom 1's
  missing `to_string` a named diagnostic instead of a C symbol.

### The conservative case: an unbound type variable

`_dyn_bound_check_type` returns `.None` — skip the check — when the payload type
IS or CONTAINS an unresolved `SomeT`. A generic body is evaluated once at
DEFINITION time with its type variables still free, and `type_implements_trait`
answers `false` there for want of a concrete: that is "unknown", not "no".
Rejecting would break every `dyn(v)` written under a `where(T <: Trait)`. Such a
site is re-evaluated with the binding in place at specialization, which is where
the bound is enforced instead. (Same conservative scoping as
`validate_where_constraints_for_call`'s no-SomeT guard —
`issues/yo-self-where-clause-full-enforcement.md`.) A `SomeT` that carries its
concrete on the per-object `resolved_concrete` cell (closures/futures) is
followed to that concrete rather than skipped.

The non-executing path additionally skips when the inner expression produced no
`ExprInfo` at all: the `t_unit()` fallback there is a stand-in, not the payload's
type, and checking it would report "unit does not implement …" on top of whatever
really failed inside the inner.

### Making the rejection survive the def-eval wall

A throw from inside a definition-time body trial is SWALLOWED by design (the
wall that masks yo-self's own porting-gap false-positives). The check therefore
flags the rejection on the flow-violation channel (`flag_flow_violation`) before
throwing, so the def-time caller re-raises it via the real `exn` — the same
pattern `anonymous_function.yo` uses for its return-type rejection. Without it
the error would be eaten and the enclosing body would silently hollow. The flag
is suppressed under `is_in_function_call_checking_phase` and under
`propagate_def_time_errors()` (the `comptime_expect_error` mode, which observes
the throw directly).

## Why `type_implements_trait`'s known incompleteness did not block this

`issues/yo-self-where-clause-full-enforcement.md` records that yo-self cannot
prove *composed/anonymous method-trait* satisfaction on concrete types
(`String <: (Eq, Hash)`), which is why call-site where-clause enforcement is
scoped to marker traits. That gap does not reach here: a `Dyn`'s
`required_trait_types` are always NOMINAL `TraitT`s (`evaluate_dyn_type` rejects
anything else), and a concrete `impl(T, Trait(...))` registers the trait by id
via `register_type_trait_value`, which is exactly what step 4 of
`type_implements_trait` looks up. Measured rather than assumed: the check is live
across `check ./std`, `check ./src`, `compile src/main.yo`, a full self-build of
the compiler (every `throw` in it goes through `Dyn(Error)`) and the language
suite, with zero over-rejections.

## std half, landed in the same change

`TlsError` was thrown as an `AnyError` from `_throw_tls` (`std/crypto/tls.yo`)
with no `impl(TlsError, Error())` — a straight D1 violation that only compiled
because of this hole, and the one std site the new check turns into a build
break. It now carries the marker. `DateTimeError` (`std/time/datetime.yo`) gets
it too: nothing dyn's one today, so it was not a break, but it is the same
oversight and the marker is what makes the first `throw` of one compile.
`PercentError` — the third type in
`issues/tls-and-datetime-errors-lack-the-error-impl-they-are-thrown-as.md` —
still needs a hand-written `ToString` and is left to that issue; nothing dyn's it,
so the new check does not reach it.

## Regression tests

`tests/dyn.test.yo`, all verified RED on the pre-fix binary ("Expected compile
error, but the expression was evaluated successfully"):

- *"Test dyn rejects a type that implements none of the Dyn's traits"* — a
  `ref(struct())` and a value `enum` with no impls at all (symptom 1, both the
  object and the auto-box path).
- *"Test dyn rejects a type that satisfies only PART of the Dyn's traits"* — a
  `ToString`-only enum into an `AnyError` (symptom 2, the silent one).

Plus the over-rejection canaries, which pass before AND after:

- *"Test Dyn(Error) over a trait default the implementor omits"* — a ref struct
  and a value enum, neither overriding `Error.source`'s `?=` default; "no impl
  for this member" must not read as "does not implement the trait", and the
  value enum pins the unbox.
- *"Test dyn inside a generic body whose concrete is still a type variable"* —
  `dyn(v)` under `where(T <: ToString)`, instantiated twice.

The pre-existing tests in the file cover the rest of the canary set: `Dyn(ToString)`,
`Dyn(Speak, Run)`, `dyn(box(v))` / `dyn(Box(T)(v))` / `dyn(v)` over primitives
and a ref struct, a Future-returning trait method, and dyn'd closures.

## Breaking change

Yes, in the sense that source which compiles today stops compiling — but only
source that is already broken at the C level (symptom 1) or that violates the
declared trait bound (symptom 2). One std site was in the second category
(`TlsError`) and is fixed in the same change. Worth a release-note line.

## Two neighbouring defects found while building the canary set — filed separately

- `issues/dyn-of-a-static-method-call-in-a-bare-tail-fn-body-loses-the-payload-type.md`
  — `dyn(String.from("…"))` as a fn's BARE TAIL types the payload as
  `fn(T : Type) -> Type` and pastes that text into C identifiers. Pre-existing;
  the new check deliberately does not fire (the payload reads as undecidable).
- `issues/dyn-of-an-existing-dyn-value-emits-an-error-comment-into-the-c.md`
  — `dyn(<a Dyn value>)` is accepted by the evaluator and refused by codegen with
  an `/* Error: … */` comment written into an expression position.
- `issues/dyn-cannot-resolve-a-trait-method-that-comes-from-a-generic-impl.md`
  — the RESIDUAL of this bug's crash face, and the reason the fix here does not
  close it entirely: when the impl comes from a blanket
  `impl(generic(T), where(T <: ToString), ArrayList(T), ToString(...))`, the
  predicate correctly answers `true` (step 8, `_find_matching_generic_impl`) but
  `_resolve_dyn_trait_values`' concrete-id-keyed registry lookup misses, so the
  same `.None` → same `__yo_wrap_…` undeclared identifier. C69 closed the case
  where predicate and vtable builder both said "no"; that issue is the case
  where they DISAGREE, and its fix is to specialize the generic impl for the
  receiver the way `_monomorphize_default_fv` already does for trait defaults.
  Measured unchanged before and after this change.
