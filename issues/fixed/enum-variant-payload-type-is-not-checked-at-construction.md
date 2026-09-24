# An enum variant constructed with the WRONG payload type passes `check` and emits ill-typed C

**Status:** FIXED 2026-09-24 (Phase 1.7 of `plans/TYPE_SYSTEM_SOUNDNESS.md`). Originally OPEN: check-green / C-red.
`plans/SELF_VERIFICATION.md` (a test passed `String` where the variant declares
`ArrayList(String)`).
**Severity:** check-green / C-red. The evaluator accepts a payload of any type;
the mistake surfaces as a C compiler error hundreds of thousands of lines into a
generated batch, with no `.yo` location.

## Symptom

```
/tmp/m0repro.c:1670:174: error: initializing '__yo_t_15874869224115770349 *'
  (aka 'struct __yo_t_15874869224115770349_struct *') with an expression of
  incompatible type '__yo_t_10944701759766193998'
  (aka 'struct __yo_t_2532957323758114092_struct')
```

Found first as `0 of 21 tests in this batch ran: the batch failed to compile`
from `yo test ./tests/internal/verifier.test.yo` — the failing construction was
one line in one test, and nothing named it.

## Reproducer

`issues/repros/enum-variant-payload-type-not-checked.yo` (12 lines):

```rust
Verdict :: enum(Proved(core : ArrayList(String)), Nope);

main :: (fn() -> unit)({
  // The declared payload is ArrayList(String); a String is passed instead.
  v := Verdict.Proved(String.from("unsat"));
  match(v, .Proved(_) => println(`proved`), .Nope => println(`nope`));
});
```

```console
$ yo check ./tmp/fixme.yo
check: ./tmp/fixme.yo — evaluator OK          # <- wrong: this is ill-typed

$ yo compile tmp/fixme.yo --optimize 2 -o /tmp/m0repro
/tmp/m0repro.c:1670:174: error: initializing ... incompatible type ...
yo: error: compile: C compiler failed (exit 1 ...)
```

## Analysis

The variant's declared field type (`core : ArrayList(String)`) is recorded on
the enum's `TypeValue`, and the emitter reads it when it writes the initializer
— which is why the C is ill-typed rather than merely odd. The evaluator's
variant-construction path does not compare the argument's type against that
declared field type, so nothing rejects the call. Compare the struct-literal
path, which does check its field types.

Not investigated: whether this is specific to a payload whose declared type is
generic (`ArrayList(T)`), or general to every variant payload. The repro uses a
generic declared type and a non-generic argument.

## Fix sketch

Check each argument against the variant's declared field type at construction,
in the same place the arity is checked, with the struct-literal path's error
shape ("field `core` expects `ArrayList(String)`, got `String`"). Needs an
over-rejection canary: variant payloads that legitimately coerce (a subtype, a
`refine(T, p)` erasure, an unresolved `SomeT` under substitution) must keep
working — see `plans/reference/REF_REFERENCE_SEMANTICS.md` and the SomeT
resolution notes in AGENTS.md.

## Test

`tests/` gains the repro as a negative case (a `comptime_expect_error`-style
check-level cli-case, since the bug is that `check` PASSES — a runtime test
cannot observe it). The existing `tests/internal/verifier.test.yo` line that
found it is now correct and is not a regression test for this.

## Scope note

Found while implementing `plans/SELF_VERIFICATION.md` M0; filed, not fixed
there. The fix is an evaluator change in the variant-construction path and
belongs in its own PR with the over-rejection canary above.

## Root cause (confirmed 2026-09-24)

Construction DOES check each payload (`calls/type.yo`, "Type mismatch for type member"); the
check passed because `are_types_compatible(String, ArrayList(String))` was true. The lenient
`Struct` arm of `src/types/compatibility.yo` treats an EMPTY name as a wildcard, and a generic
instantiation's name is empty (only `::`-bound declarations are stamped). The struct-literal path
the doc compares against fails the same way for the same pair; it simply had no test.

## Fix

The lenient arm rejects, before the wildcard, two SomeT-free structs with different ids when one
is a generic instantiation (a constructor id) and the other is a declared non-generic struct (a
stamped name, no constructor id), or when both are instantiations of different constructors. This
is the part of Phase 3.2 ("an empty name is no longer a wildcard") that the construction check
needs; the rest of 3.2 stays with
`issues/struct-compatibility-accepts-a-name-match-or-an-anonymous-wildcard.md`.

## Verification

The repro is E0605 `Type mismatch for type member "core": Expected: ArrayList(String), Got:
String`. `tests/type_soundness.test.yo` adds the rejection and a canary that the declared payload
type still constructs; `check ./std` 176/176 and `check ./src` 279/279.
