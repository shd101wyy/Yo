# `downcast(dyn(x), T)` is rejected with "got Option" — a diagnostic that names the wrong type

**Severity:** S3 — `downcast(dyn(x), T)` rejected with "got Option" — diagnostic names a type that appears nowhere in the operand

**Status:** FIXED 2026-10-04 — see "Fixed" below. (Before that: OPEN. The symptom
morphed after filing: the "got Option" expected-type leak was fixed separately,
but the same expression then fell into a WORSE hole — `yo check` passed it
entirely and `yo compile` died inside the C compiler on
`/* Error: dyn() call missing trait values */`. Both are gone; see "Fixed".)
**Found:** 2026-09-05, writing the regression test for
`issues/fixed/downcast-to-a-never-dyned-value-type-emits-invalid-c.md` (the test
wanted a downcast whose operand is not a plain local).
**Severity:** bad diagnostic. The rejection itself is defensible — a bare
`dyn(x)` in that position has nothing to say WHICH `Dyn` to build — but the
message names `Option`, which appears nowhere in the operand, so it sends the
reader looking at the wrong expression.

## Symptom

```rust
{ assert } :: import("std/assert");
open(import("std/string"));
open(import("std/fmt"));

Cat :: ref(struct(name : String));
impl(Cat, ToString(to_string : (self -> self.name)));
Animal :: Dyn(ToString);

main :: (fn(io : Io) -> unit)({
  assert(downcast(dyn(Cat(`shadow`)), String).is_none(), "expected None");
});
export(main);
```

```
error: downcast expects a Dyn type as first argument, got Option.
```

with the caret under `dyn`. Nothing in the operand is an `Option` — the only
`Option` in sight is `downcast`'s own RESULT type, which is what appears to have
been handed back to `dyn()` as its expected type.

The same expression written through a binding or a call is accepted:

```rust
(animal : Animal) = dyn(Cat(`shadow`));
assert(downcast(animal, String).is_none(), "expected None");     // OK

make_animal :: (fn() -> Animal)(dyn(Cat(`shadow`)));
assert(downcast(make_animal(), String).is_none(), "expected None"); // OK
```

Both give `dyn()` an expected type (the annotation, the declared return type),
which is the information a bare argument position lacks.

## Expected

Either

- infer the `Dyn` from `downcast`'s first-parameter type, if that is a concrete
  `Dyn(...)` at the call — it is not, `downcast` accepts any `Dyn`, so probably
  not; or
- reject with a message that names the real problem, e.g. *"cannot infer the Dyn
  type of `dyn(...)` here — annotate the value or bind it first"*, pointing at
  the `dyn` token.

The current text asserts a fact about the operand's type that is not true.

## Where to look

The expected type flowing into the argument. `downcast`'s builtin evaluation is
`src/evaluator/builtins/downcast.yo`; the "expects a Dyn type as first argument"
text is the check it makes after evaluating that argument, and the `Option` it
reports is the type the argument came back as — i.e. the expected type pushed
into the argument was the CALL's result type, not the parameter's.

## Not blocking

The two accepted spellings above are unambiguous and are what the regression
tests use.

## Fixed

Root cause (confirmed 2026-10-04 in the evaluator and the emitted C): between
the filing and the fix the "got Option" leak was already gone, but the same
expression then fell into a quieter hole. `evaluate_dyn_value`'s NON-EXECUTING
path — the one `yo check` uses for fn bodies — silently substituted an EMPTY
`DynT` (zero required/negative traits) whenever `ctx.expected_type` was
`.None` (`src/evaluator/values/dyn.yo`). `is_dyn_type` matches the empty DynT,
so `downcast`'s own "expects a Dyn type as first argument" check passed,
`_resolve_dyn_trait_values` iterated the empty trait list, and C codegen
emitted `(void)(/* Error: dyn() call missing trait values */)` — not valid C.
`yo check` was green; `yo compile` died with `error: expected expression` on
the generated `.c`. The escape was not downcast-specific: a bare `dyn(...)` in
ANY argument position whose parameter is not a `Dyn(...)` adopted that
parameter's type verbatim (`f(dyn(Cat(...)))` with `f : (fn(n : i32))` also
passed check), and an unannotated `x := dyn(...)` took the empty DynT.

The fix mirrors what the EXECUTING path always did: the Dyn must be NAMED —
by the expected type when it is a `Dyn(...)`, else by the payload's own trait
bounds (an `Impl(...)`/SomeT value carries them); with neither, the dyn is
rejected at its own token with E0605, "cannot infer the Dyn type of dyn(...)
here: <this position supplies no expected type | the expected type X is not a
Dyn(...)>. Annotate the value or bind it first — e.g.
(x : Dyn(Trait)) = dyn(value) — or pass dyn(value) where a Dyn(...) is
expected." (`_dyn_type_from_payload_or_throw` + the reworked `ret_type`
derivation, `src/evaluator/values/dyn.yo`.) An inner that produced no
ExprInfo keeps the old stand-in — its own failure has already been reported.
Not a breaking change: every position that reached codegen on the empty DynT
was ALREADY emitting the invalid-C comment, so no program that compiled
before stops compiling; verified with `yo check ./src` (278/278) and
`yo check ./std --std-path ./std` (178/178) — every `exn.throw(dyn(...))`
site in both trees goes through `throw`'s `AnyError` parameter, which supplies
the expected type.

Test: `tests/dyn.test.yo` — "Test downcast rejects a bare dyn() operand it
cannot infer a Dyn for": the issue's own expression under
`comptime_expect_error(..., "cannot infer the Dyn type")`, with the two
accepted spellings (annotated binding, declared return type) as over-rejection
canaries in the same batch. Verified RED first — the whole 32-test batch
failed to compile on the "expected an error, none was raised" throw — and
GREEN after (32/32, plus error/error_ergonomics/error_source_chain/
type_soundness/closure files and the full fast language suite, 4945/4945).

One follow-up is deferred: the `dyn(x)` bullet in
`.github/skills/yo-core-patterns/core-patterns-cheatsheet.md` still describes
the old "misleading message" and cites this doc's old root path; refreshing it
requires the seven-case cli-golden re-record that can only run on a POSIX host
(`issues/cli-case-goldens-cannot-be-recorded-from-a-windows-host.md`).

Fixed 2026-10-04 on branch `s3/batch-2-fixes`.
