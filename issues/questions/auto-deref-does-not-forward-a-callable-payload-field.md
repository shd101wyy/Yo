# Auto-dereference does not forward a call of a function-typed payload field

**Kind:** design question — an open decision, not a defect. Found 2026-10-04
while implementing the `Deref` marker and auto-dereference
(`plans/VALUES_BY_DEFAULT.md` §3.3, V1).

## The gap

On a `Box`/`Arc`, auto-dereference forwards a field the wrapper lacks
(`b.x` is `b.*.x`) and a method the wrapper lacks (`b.m()` is `b.*.m()`).
It does not forward a **call of a payload field whose type is a function**:

```rust
H :: struct(f : (fn(x : i32) -> i32));
b := box(H(f : (fn(x : i32) -> i32)((x + i32(1)))));
b.*.f(i32(1));   // works
b.f(i32(1));     // E0610: No method "f" on Box(H) ... its payload H has no field or method "f" either.
```

The two hooks split by position: the field hook (the label-miss arm of
`evaluate_property_access`) runs only outside callee position, because a
dot callee `w.m` must first be offered to the wrapper's methods. The method
hook (`_try_find_receiver_method`) retries with `w.*` but looks up methods
only. A plain struct `p.f(1)` with a function field works, because there the
label hits before any method lookup. The E0610 wording is accurate, since
it says "field or method", but the field exists.

## Options

1. **Forward it.** In the method retry, when the payload has no method `m`
   but has a field `m`, rewrite the callee's receiver to `w.*` and let the
   ordinary callable-field path run. Precedence would be: wrapper field,
   wrapper method, payload field, payload method. That differs from a
   plain struct, where a field beats a method. Neither cell has a field
   other than `*`, so the difference cannot be observed today.
2. **Keep it explicit.** A function-valued field reached through a wrapper is
   spelled `w.*.f(...)` (Rust also needs `(w.f)(...)` for a field call).
   Improve E0610 to say "`f` is a field of the payload; call it as
   `b.*.f(...)`".

## Recommendation

Option 2 now. The diagnostic change is small and keeps the two hooks'
rules simple, and function-typed fields inside a `Box`/`Arc` are rare in
the tree. Revisit when V4 moves the compiler's trees to `Box`: if the
explicit `.*` calls become common there, take option 1.
