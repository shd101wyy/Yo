# Verifier: a variant with a payload (and a qualified `Enum.Variant`) could not be constructed at all, not only in a `cond` arm

**Severity:** S3 — `yo verify` reported a subset error (never a wrong verdict) for any verified body that constructed a payload-carrying variant, or spelled a zero-field one as `Enum.Variant`.

- **Status:** FIXED on `fix/verifier-cond-arm-construction` (2026-10-01).
- **Component:** `src/verifier/vc.yo` — `_call_term`'s enum-construction
  branch, `_enum_ctor_term`.
- **The title is the original filing's.** It was measured only inside a
  `cond` arm; the construction fails in every position.

## Reproducer (measured with develop's tree build at `6f5dec5db`)

```rust
pragma(Pragma.Verify);
Color :: enum(Red, Green(v : i32));

stmt_short :: (fn(b : bool, ensures(r == i32(1))) -> (r : i32))({
  (c : Color) = .Green(i32(7));
  match(c, .Red => i32(0), .Green(_) => i32(1))
});
```

This and its three siblings (`Color.Green(i32(7))`, and both spellings
inside `cond` arms) gave `subset — call to an uncontracted, untyped callee`.
The compiler built before #1053 (develop `5101639ad`) gave `non-atom enum
variant in construction` for all four. So it never worked; #1053 only
changed the message.

## Root cause

The construction branch assumed `.Variant(args...)` parses as
`.(Variant, args...)`, a dot call whose first argument is the variant. That
holds only for a zero-field `.Red`. A payload variant parses as
`(.Variant)(payload...)` or `(Enum.Variant)(payload...)`: the callee is
itself a dot call, and this call's arguments are the payload. A qualified
zero-field `Color.Red` parses as `.(Color, Red)`, where the variant is the
SECOND dot argument.

## Fix

- `_payload_ctor_variant` recognizes `(.V)(...)` and `(E.V)(...)` when the
  call is enum-typed and is not an instance method call. `xs.get(i)` has
  the same shape; its callee is in the method-callee table.
- `_qualified_nullary_variant` recognizes `.(E, V)`.

Both route to the existing `_enum_ctor_named`. Pinned by
`tests/spec/fixtures/valid/variant_payload_construction.yo` (6 ok) and its
false twin `negative/variant_payload_construction_false.yo` (2 refuted),
driven from `tests/internal/verifier_list_len.test.yo`.
