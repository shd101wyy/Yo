# A match on an `Rc` handle lowers to a test chain instead of a `switch`

**Severity:** S3. Emitted-code shape only: the C is correct, but every
arm is a separate tag test.

## Symptom

`match(t, .Func(...) => …, .Struct(...) => …, _ => …)` with `t` a
`TypeValue :: Rc(TypeValueNode)` handle emitted one
`if (!((t->_u42_).tag == X)) goto __yo_mN_aK;` per arm.

On the handle tree, the compiler's own C carried 7,872 such tests, against
develop's 1,715, where `TypeValue` was a `ref(enum)` and the same matches
were `switch`es.

## Root cause

An arm whose pattern looks through the `Rc` implicitly compiles to
`Pattern.ThroughBox`, which `arm_is_classic` rejects. So
`_generate_match_expression_body` (`src/codegen/exprs/match.yo`) sent the
whole match to the general lowering, even when every arm was a plain
variant shape.

## Fix

`_lookthrough_switch_cell` accepts a BORROW match when every arm is one of:
- a classic `_`;
- an implicit look-through, at one `Rc` cell type, of a classic variant
  pattern whose fields are binders or `_` only.

The subject then becomes the cell's payload field, and the pre-IR switch
emitter lowers the match on the payload's tag.

With no literal field, each variant's arms cover it, so the switch drops no
miss. This is the soundness rule the evaluator's group-coverage check
enforces for a plain enum. Everything else keeps the test chain: guards,
literal fields, explicit `Rc(p)` arms, consume matches and `mut` matches.

## Tests

`tests/match_nested.test.yo`, "a match on an Rc handle with plain variant
arms switches on the payload". It compares the switch shape with a
literal-field arm and a guarded arm, which keep the chain. The compiler's
self-build exercises it on every `TypeValue` match: the emitted C has
3 MB less code and the Tier 1 battery passes.

There is no C-shape regression test. The emitted-C size on the
self-build is the measurement (138.4 MB on develop, 135.3 MB on the handle
tree with both fixes).
