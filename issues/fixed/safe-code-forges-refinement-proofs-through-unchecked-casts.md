# Safe code forges refinement proofs through `std/spec/refine.unchecked*`

**Severity:** S2 — a file with no `pragma(Pragma.AllowUnsafe);` constructs a
`Refine(T, p)` value violating `p`, forging the proof the verification model
says a call site must discharge

**Found**: 2026-10-01, by the safe-mode handover §3.2 audit
(`plans/SAFE_MODE_HANDOVER.md`): `*_unchecked` is one of the audited classes;
these three were the only `unchecked`-named public APIs left in std after
`String.from_bytes` was checked (its invalid-UTF-8 product is mojibake and
panics, not UB — std's own `read_line` hands back unvalidated bytes).
**Fixed**: same day, with a `*(T)` witness parameter.

## Symptom

`std/spec/refine.yo`'s own doc on `unchecked` says: "Callers take
responsibility for `p(x)` holding; pair the call site with
`pragma(Pragma.AllowUnsafe)`." Nothing enforced that — the exported trusted
casts had pointer-free signatures, so this safe file compiled clean:

```rust
{ unchecked_non_zero } :: import("std/spec/refine");

main :: (fn() -> unit)({
  bad := unchecked_non_zero(i32(0));   // NonZero(i32) holding 0
  println(bad);
});
export(main);
```

Today the damage is verification-soundness, not runtime UB: refinements are
erased at codegen, entry assumptions are `assumed()`, and guard elision's
filter keeps a guard when an unenforced assumption is on its path. But the 5b
elision design trusts refined params at callee entry, so a forged `NonZero`
reaching a `num / denom : NonZero(i32)` is a future elided div-by-zero check —
the hole grows into S1 as 5b Phase 3 lands. `unchecked(p, x)` and
`unchecked_bounded(x, lo, hi)` are the same cast for arbitrary predicates.

## Root cause

The contract lived in a doc comment. Yo has no `unsafe fn` (deliberately —
`plans/reference/MEMORY_SAFETY.md` "No function coloring"), so a plain
exported function is callable from every file unless one of its parameter or
result types is unavailable in safe code.

## Fix

Each trusted cast now takes a `witness : *(T)` parameter the caller fills with
`&(x)`:

```rust
v := i32(9);
blind := unchecked(non_zero_i32, v, &(v));
```

A safe file cannot produce the argument — `&(x)` is itself gated in safe code
with the address-of diagnostic — which enforces exactly the doc's contract.
The witness is not inspected. `std/spec/refine` is an unstable surface (the
verification campaign expects the spellings to move); if a richer mechanism
arrives (verifier-issued proof tokens), the witness is the stopgap it
replaces. `tests/spec/refine_types.test.yo`'s two `unchecked` call sites pass
`&(nz3)` / `&(v)`.

## Verification

- `tests/safe_code_structural_gates.test.yo` pins
  `comptime_expect_error(unchecked_non_zero(i32(0)))` — red before, green
  after (arity error on the two-argument spelling).
- `tests/spec/refine_types.test.yo`'s trusted-cast tests still pass with the
  witness (the file has `pragma(Pragma.AllowUnsafe);`).
