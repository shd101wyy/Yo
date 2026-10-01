# Verifier: the final `match` arm dropped its pattern bindings before walking its body

**Severity:** S3 — `yo verify` reported "unbound runtime name 'v'" (a subset error, never a wrong verdict) for any `match` whose LAST arm binds a payload, e.g. `.Green(v) => v`.

- **Status:** FIXED on `fix/verifier-cond-arm-construction` (2026-10-01).
- **Component:** `src/verifier/vc.yo` — `_match_last_arm_ir`.

## Reproducer (measured on the same branch before this fix)

```rust
payload_read :: (fn(ensures(r == i32(7))) -> (r : i32))({
  (c : Color) = .Green(i32(7));
  match(c, .Red => i32(0), .Green(v) => v)
});
```

`subset — cannot verify: unbound runtime name 'v'`.

## Root cause

`_match_last_arm_ir` bound the pattern (`_arm_ir_bind`) and then called
`_restore_vars` BEFORE walking the body, so the body saw none of the
bindings. The non-final path (`_match_arm_conditioned_ir`) restores after
the body. Every existing test that binds a payload does so in a non-final
arm, so none noticed.

## Fix

Walk the body, then restore. Pinned by `payload_read` and `last_arm_binds`
in `tests/spec/fixtures/valid/variant_payload_construction.yo`.
