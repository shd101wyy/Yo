# A `mut(...)`-marked bare field in a record destructure binds positionally, while the same field unmarked binds by label

**Severity:** S3 — `{ a, mut(b) } := s` binds `b` from `s`'s field at that INDEX, while `{ a, b } := s` binds `b` from `s`'s field NAMED `b`. For a record whose field order differs from the destructure order, the marked form silently binds the wrong field. Pre-existing (identical tree before and after the desugar-time strip, below); discovered by decision 47's new parser tests.

## Symptom

The parser pair-ifies only BARE ATOM fields of an anon-struct (`{ x, y: 2 }` → `_(x: x, y: 2)`, `src/parser.yo`'s anon-struct build). `mut(b)` is a call, so it is never pair-ified:

```yo ignore
{ a, b } := s      // parses to _(a : a, b : b) — both fields LABELLED
{ a, mut(b) } := s // parses to _(a : a, mut(b)) — b is left BARE
```

After decision 47's strip (at desugar since `fix/ast-immutable-before-b8`; at evaluation before it, by the in-place `strip_mut_marker` write), the marked form is `_(a : a, b)`: the evaluator's destructuring treats a bare non-pair field as POSITIONAL (`field_index = i`, `src/evaluator/exprs/destructuring_assignment.yo`), so `b` reads `s`'s field at index 1 — whatever it is named. The unmarked form's `b : b` pair binds by the LABEL `b`, with an unknown-field error when it does not exist.

So for `S :: struct(p : i32, q : i32)` and `(s : S) = S(p : 1, q : 2)`:

```yo ignore
{ p, mut(q) } := s // q := s.q by luck of the order — index 1 IS q
// but with T :: struct(q : i32, p : i32):
{ p, mut(q) } := t // q binds t.p (index 1), not t.q
```

## Root cause

The marker is not part of the field-name grammar the parser's pair-ification covers; the old in-place strip replaced `mut(b)` with the bare atom `b` and nothing re-ran the pair-ification. The desugar-time strip (`_strip_destructuring_fields`, `src/expr.yo`) reproduces the old tree exactly — this branch deliberately changes nothing about binding.

## Recommendation

In `_strip_destructuring_fields`, strip a BARE marked field of an ANON_STRUCT (`_`) destructure to the PAIR `b : b` (the parser's own pair-ified shape) instead of the bare atom — tuple and variant payloads stay positional by design. That makes `{ a, mut(b) } := s` bind by label like `{ a, b } := s`, and the parser-test assertion can go back to comparing the two parses. Tuples (`(a, mut(b)) := t`) and variant payloads (`.Some(mut(b))`) must keep positional binding.

## Verification of the current behavior

`tests/internal/parser.test.yo` "decision 47: a binder's mut(name) is stripped at desugar" pins the current (positional) tree with a literal; the issue reference there points here.
