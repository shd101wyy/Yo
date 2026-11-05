# A folded field read of a struct literal drops the literal's calls

**Severity:** S2 — wrong output: a read of a compile-time-known field of a struct literal whose other fields are runtime calls is emitted as the constant, and the calls never run (their side effects are lost).

Found 2026-11-05 while fixing
`issues/fixed/2026-11-05-a-method-on-a-field-of-a-match-binding-over-an-inline-literal-emits-an-undeclared-identifier.md`.

## Reproducer

`issues/repros/2026-11-05-folded-struct-literal-field-read-drops-calls.yo`
(`yo compile <it> -o r && ./r` prints `1 2 calls=1`; expected `1 2 calls=2`):

```yo ignore
a := P(x : f(), y : i32(1)).y; // emitted as `int32_t a = 1;`: f() never runs
b := (f(), i32(2)).1;          // the tuple's call does run
```

## Root cause (as far as read)

The evaluator gives the field read the value `IntLit(1)` (the construction is a `StructVal` shell
whose `y` leaf is known), and the binding's initializer is emitted from that value, before
`_generate_field_access_raw` (`src/codegen/exprs/property_access.yo`) is reached. The tuple form
keeps its call, so the struct path folds where the tuple path does not. A read may be folded
only when its object has no runtime leaf (`value_contains_unknown`), as the field-access emitter
itself now requires; otherwise the read must evaluate the object.
