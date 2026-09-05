# `dyn(x)` never checks that `x`'s type implements the Dyn's traits

**Status:** OPEN
**Found:** 2026-09-04, measuring the `error`/`assert` row of the std API audit
(the row's `derive(Error)` item asks what `impl(_, Error())` actually buys — the
answer is: nothing, the compiler never reads it).
**Severity:** api-lie, with a crash face. A plain type error is reported as an
undeclared C identifier, and the documented rule "an error type is a real enum
implementing `Error()`" (`.github/instructions/yo-design.instructions.md:500-502`)
is unenforced — so `impl(_, Error())` is decorative.

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

`yo check` — clean (rc=0). `yo compile … --optimize 2`:

```
d2.out.c:538:36: error: use of undeclared identifier '__yo_wrap___yo_t8___yo_t0_to_string'
1 error generated.
yo: error: compile: C compiler failed (exit 1) on d2.out.c
```

Expected: an evaluator error at the `dyn(...)` site saying `NoTraits` does not
implement `ToString` (required by `Error`'s `where(Self <: ToString)`).

The emitted C shows both halves of the mechanism — the wrapper was skipped with a
comment, the vtable still points at it:

```c
/* Warning: Module field to_string is not a function value */      // line 524
…
  .to_string = (__yo_t4 (*)(void*))__yo_wrap___yo_t8___yo_t0_to_string,   // line 538
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

Compiles, runs, rc=0:

```
boom
none
impls Error: false
```

`AnyError` is `Dyn(Error)` (`std/error.yo:16`), yet a type the compiler itself
says does NOT implement `Error` is stored in one and dispatched through it. The
`source()` slot resolves to the trait's `?=` default, so nothing even looks
wrong at runtime.

## Root cause

`evaluate_dyn_value` (`src/evaluator/values/dyn.yo:282`) builds the Dyn's trait
values through `_resolve_dyn_trait_values` (`:163-281`), which — per required
trait, per method label — searches the concrete type's registered trait methods,
then falls back to the trait's `?=` default, and finally pushes whatever it got:

```rust
field_vals.push(resolved_field);        // src/evaluator/values/dyn.yo:248
```

`resolved_field` is an `Option(EvalValue)`; a method the concrete type does not
implement (and that has no trait default) yields `.None`, and that `.None` is
pushed without complaint. There is no trait-satisfaction check anywhere on the
coercion path — `grep -nE "impls|does_type_implement|satisf|check_trait|trait_impl"
src/evaluator/values/dyn.yo` returns nothing.

Codegen then diverges on that `.None`:

- the wrapper emitter skips the method and writes a comment
  (`src/codegen/functions/dyn.yo:493` — `/* Warning: Module field ${label} is not
  a function value */`);
- the vtable emitter names the wrapper unconditionally for every trait slot whose
  first parameter is `self` (`src/codegen/functions/dyn.yo:646-650`).

Hence `use of undeclared identifier '__yo_wrap_…_to_string'`.

The mechanism the fix needs already exists and answers correctly:
`type_implements_trait` (`src/evaluator/trait_checking.yo:649`) and its boolean
wrapper `type_implements_trait_bool` (`:1162`) — `Type.impls(NoErrImpl, Error)`
routes through them and prints `false` above.

Someone noticed the gap and left it as a comment instead of a test:
`tests/dyn.test.yo:110` — `// Dog :: struct(); // This should give error working
with dyn.`

## Consequences beyond the bad diagnostic

- `impl(_, Error())` is unenforced, so D1's "every error type is a real enum
  implementing `Error()`" is a convention, not a rule — see the sibling issue
  `issues/tls-and-datetime-errors-lack-the-error-impl-they-are-thrown-as.md`,
  which is only compilable because of this hole.
- A `derive_rule(Error, …)` (the audit row's own item) derives a marker nothing
  reads.

## Fix

In `evaluate_dyn_value`, before/while resolving trait values, check the concrete
type against each required trait of the target `Dyn` with
`type_implements_trait` and throw a `format_error_message` at the `dyn(...)`
token naming the type, the trait and (from `TraitCheckResult`) the missing
member. Equivalently, and more cheaply, treat a `.None` `resolved_field` in
`_resolve_dyn_trait_values` (`src/evaluator/values/dyn.yo:230-248`) as the error
condition — it is exactly "no impl and no default for this required member" —
but prefer the `type_implements_trait` form so the message can name the trait
rather than one method.

Skip the check for the non-`TraitT` arms already handled there: `FnTraitT`
(`:261-273` — a dyn'd closure IS its own implementation, there is no registry
impl to find) and any `Dyn` required-type that is not a nominal trait.

### This is a NEW REJECTION — gate it accordingly

Per the standing rule for guards that add rejections, land it with an
over-rejection canary for every legal `Dyn` shape already in the tree, not just
the new expect-error test:

- `Dyn(ToString)`; `Dyn(Speak, Run)` (`tests/dyn.test.yo:103`);
- `Dyn(Error)` from a `ref(struct(...))` AND from a value enum (the auto-box
  path — the check must run on the UNBOXED concrete, cf.
  `_unwrap_box_for_method_lookup`, `src/evaluator/values/dyn.yo:109`);
- a trait with a `?=` default the implementor omits (the `Error.source` case —
  must stay legal);
- a trait with a Future-returning method (`tests/dyn.test.yo:245`);
- a `dyn()` inside a generic/comptime body where the concrete is still a `SomeT`
  at definition time — must not reject (mirror the existing def-time-trial
  leniencies).

Gates: `yo check ./std`, `yo check ./src`, the ~30 min language suite, and
`yo compile src/main.yo --skip-c-compiler` (the async state-machine rules only
fire in codegen).

## Regression test

`tests/dyn.test.yo`: turn `:110`'s comment into a real
`comptime_expect_error` — `dyn(<type with no impls>)` into a `Dyn(Trait)` must be
rejected with a message naming the trait. Verified RED first (today it compiles
and only clang objects). Plus the canary list above as ordinary passing tests.

## Breaking change

Yes, in the sense that source which compiles today stops compiling — but only
source that is already broken at the C level (symptom 1) or that violates the
declared trait bound (symptom 2). Two std sites are in the second category and
must be fixed in the same PR (`issues/tls-and-datetime-errors-lack-the-error-impl-they-are-thrown-as.md`). Call it out in the release
notes.
