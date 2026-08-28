# Non-exact type compatibility accepts `Result(i32, AErr)` where `Result(i32, BErr)` is expected — same-named generic instantiations unify by NAME only

**Status:** **FIXED 2026-08-29** (`src/types/compatibility.yo`): under equal
(or empty) names the non-exact enum arm walks the variant payloads and the
struct arm the recorded `type_arguments` pairwise; two SomeT-free positions
that are not themselves non-exact-compatible make the types different.
Placeholders are read through one level of their resolution cell (an
instantiation keeps the declaration's `SomeT` in its field lists — the first
attempt never fired for that reason); an unresolved placeholder stays a
wildcard, so def-time bodies and `Option(T)` vs `Option(i32)` are untouched.
Cycle-guarded with the existing visited keys (an unguarded first cut SIGBUSed
`check ./std` on a recursive type). Field-type recursion for structs was
tried and dropped — it broke prelude evaluation (derive rules, `Pragma`).
Same-shaped twin enums additionally need C46's nominal exact rule; the test
`tests/generic_instantiation_compat.test.yo` covers both faces and passes with
both in the tree. **Found:** 2026-08-29
while pinning issues/fixed/structurally-identical-error-enums-in-two-generic-impls-collide.md
(the EXACT comparison's nominal fix); this is the NON-exact comparison's
sibling hole. **Severity:** MEDIUM — a soundness gap in the type checker
(`yo check` green on an ill-typed assignment); the emitted C is the second
enum's layout reinterpreted as the first's, so the wrong payload is read at
runtime.

## Reproducer

```rust
AErr :: enum(Boom(code : i32), Quiet);
BErr :: enum(Boom(code : i32), Quiet);
fa :: (fn(fail : bool) -> Result(i32, AErr))(cond(fail => .Err(.Boom(code : i32(1))), true => .Ok(i32(10))));
main :: (fn() -> unit)({
  r := fa(true);
  (x : Result(i32, BErr)) = r;   // ❌ accepted — should be "Incompatible types"
  consume(x);
  ();
});
```

`yo check` passes. The direct form is rejected as it should be:

```rust
e := AErr.Quiet;
(y : BErr) = e;                  // ✅ "Incompatible types"
```

The shapes are unrelated to the payloads being enums — a struct payload
(`Result(i32, SomeStruct)` vs another same-shaped struct) or a nested generic
(`Option(Result(...))`) goes through the same fast path.

## Mechanism

`_compat_impl`'s `EnumT` arm, non-exact mode:

```rust
!(require_exact) => (((aname == ename) || (aname.len() == usize(0))) || (ename.len() == usize(0))),
```

Equal (or empty) names are accepted OUTRIGHT — no recursion into the variant
field types. Every `Result(_, _)` instantiation is named "Result", so any two
of them are mutually assignable under non-exact compatibility, which is what
assignment, argument passing and return checks use. The `Struct` arm's
non-exact path has the same equal-name fast accept (`=> true`) and therefore
the same hole for `Carrier(AErr)` vs `Carrier(BErr)`.

The comment above the struct arm records why the fast path exists ("Restore TS
behavior: accept the empty-name / equal-name wildcard fast paths") — the
TypeScript reference had the same hole; it was carried over, not chosen.

## What the fix looks like (not done here)

Under equal non-empty names, recurse NON-exact over the variant field types
pairwise (enum arm) / the `type_arguments` then field types (struct arm), with
the existing cycle guard — a `SomeT` on either side stays compatible, so
generic placeholders and def-time bodies are unaffected, while two concrete
instantiations that differ in a payload type are told apart. This perturbs
compatibility globally (assignment, calls, returns, the era-convergence cases
the struct-arm comment lists), so it must land alone with the full battery —
which is why it is filed rather than folded into the exact-comparison fix.

## Pinned

`tests/generic_instantiation_compat.test.yo` (RED on develop before the fix:
"Expected compile error, but the expression was evaluated successfully") and
`tests/nominal_enum_identity.test.yo` for the direct case.
