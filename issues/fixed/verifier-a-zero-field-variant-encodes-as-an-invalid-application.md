# Verifier: a zero-field enum variant encodes as `(Name)`, so a true contract is reported REFUTED

**Severity:** S2 — `yo verify` rejected valid programs: any verified body that constructed a zero-field variant (`.Red`, `.None`) got REFUTED with an arbitrary counterexample.

- **Status:** FIXED on `feat/verifier-list-get-pop` (2026-09-30), found while
  modeling `ArrayList.get` (R1 slice 3), whose `None` arm hit it first.
- **Component:** `src/verifier/encode.yo` — `encode_term`, the `.Ctor` arm.

## Reproducer (measured with the tree build of the branch before the fix)

```rust
pragma(Pragma.Verify);
Color :: enum(Red, Green(v : i32));

pick :: (fn(b : bool, ensures(r == i32(0))) -> (r : i32))({
  (c : Color) = .Red;
  match(c, .Red => i32(0), .Green(_) => i32(1))
});
```

`yo verify` reported `REFUTED`. The script held
`(__yo_denum_decl_tmp__nullary_Color_r0c9_Red)`, and z3 answered

```
(error "line 8 column 113: invalid function application, arguments missing")
sat
```

## Root cause

`encode_term` rendered every `VcTerm.Ctor` as `(<name> <args>...)`. SMT-LIB
spells a zero-argument application as the bare symbol. Z3 rejected the
assertion, still answered `sat` for the remaining script, and the harness
read that `sat` as a refutation (the separate harness hole fixed by
`issues/fixed/verifier-a-malformed-smt-script-reports-refuted-with-an-empty-model.md`,
PR #1050, which turns this class into a `solver-error`).

Existing tests missed it because they only MATCH on zero-field variants
(testers `is-Name`) and never construct one.

## Fix

A `.Ctor` with no arguments encodes as its bare name. Pinned by the unit test
"encode_term: a zero-field constructor is the bare symbol, not (Name)" in
`tests/internal/verifier.test.yo` and the fixture
`tests/spec/fixtures/valid/nullary_variant_construction.yo`.
