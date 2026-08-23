# A comptime field in a reference struct breaks the constructor's arity

**Status: FIXED 2026-08-23.** `src/codegen/exprs/other_fn_call.yo` — the
reference-struct constructor call site now prefers the FIELD-DRIVEN
reconstruction (`_ctor_args_from_labeled`, which walks
`get_runtime_struct_fields` — the same view the constructor's parameter list is
built from, so it has the right arity by construction) whenever the evaluator's
recorded `runtime_arg_exprs_in_order` OVERSUPPLIES and the reconstruction
matches the parameter count. Deliberately narrow: a recorded list that merely
differs for some other reason is left alone, so this cannot perturb the
constructor calls that work today.

The evaluator side is left as-is on purpose. It has the right machinery — the
per-arg `rt_ct_flags_args` filter that already excludes comptime args, and a
`g_struct_field_comptime_flags` registry — but the synthesized constructor's
parameter flags do not pick the field flags up, and threading them through is a
larger change in the constructor-synthesis path than the codegen-side arity
guard, which fixes the observable defect at the point it manifests. If the
evaluator side is ever corrected, this guard becomes redundant rather than
wrong.

Gate: `tests/ref_struct.test.yo` "A reference struct may have a comptime field
named header" now CONSTRUCTS such a value (two arms: the reserved name and an
ordinary one, so the arity fix is pinned independently of the reserved-name
rule).

## Symptom

A `ref(struct(...))` that mixes a COMPTIME field with a runtime one emits a
constructor call carrying the comptime argument, while the constructor's
signature (correctly) has only the runtime parameters:

```
error: too many arguments to function call, expected single argument 'n', have 2 arguments
```

`yo check` passes. The failure is purely in the emitted C.

## Minimal reproducer (verified failing on unmodified develop)

```rust
{ String } :: import("std/string");
{ println } :: import("std/fmt");
CT :: ref(struct(tag :: 1, n : i32));
main :: (fn() -> unit)({
  c := CT(n : i32(5));
  println(`n=${c.n.to_string()}`);
});
export(main);
```

`yo check repro.yo` → OK. `yo compile repro.yo --release -o repro` → the error
above.

DECLARING such a type is fine — only CONSTRUCTING it fails, which fits the
diagnosis: the constructor is emitted lazily at the first use.

## Where the halves disagree

The constructor's PARAMETER list is built from `get_runtime_struct_fields`
(`src/codegen/utils/index.yo`), which correctly drops comptime fields — the
declaration in `src/codegen/functions/constructors.yo` and the prototype in
`declarations.yo` therefore take runtime fields only. The struct-literal CALL
site apparently walks the full `field_labels` / `field_types` instead, so it
passes one argument per DECLARED field.

The comptime flags are recorded at `src/evaluator/types/struct.yo` (pushed into
`field_comptime_flags` beside `field_labels`), so the information the call site
needs is available; it just is not consulted.

## Fix direction

Make the struct-literal emitter filter its arguments through the same
`get_runtime_struct_fields` view the constructor's parameter list uses, so both
sides are derived from ONE source. That is the pattern the constructor
declaration already documents as a deliberate divergence-avoidance measure
(`generate_object_constructor_declarations`'s comment: "sharing the source
guarantees the forward declaration's parameter list matches the definition's").

Check the value-struct path too: a value struct with a comptime field may or may
not have the same mismatch, since it has no constructor function and is emitted
as a compound literal.

## Test to add with the fix

The reproducer above, plus a value-struct twin, plus a comptime-only reference
struct. `tests/ref_struct.test.yo` currently has a DECLARE-ONLY arm for this
shape ("A reference struct may DECLARE a comptime field named header") which
deliberately avoids constructing — turn it into a constructing arm once this is
fixed.

## Precedent: the VALUE-struct twin was fixed a month earlier

`issues/fixed/yo-self-comptime-field-struct-ctor.md` (2026-07-20) is the same
class one path over: a VALUE struct with a comptime-only field emitted
`(__yo_t0){ .next = __yo_t0 }` — the field paired against the wrong argument —
and was fixed in the value-struct constructor branch of the same file
(`other_fn_call.yo` ~1398). The REFERENCE-struct branch (~1470) never got the
equivalent treatment, so it kept pairing positionally against the full declared
field list. Worth knowing for anyone touching either branch: they are siblings
that must both derive their argument list from the runtime-field view, and only
one of them did.

## How it was found

While adding an over-rejection canary for
`issues/fixed/ref-struct-field-named-header-collides-with-rc-header.md`: the
new arm constructed `ref(struct(header :: 1, n : i32))` to prove the
reserved-name check does not fire for comptime fields, and the batch failed to
compile for this unrelated reason. The canary was narrowed to a declaration.
