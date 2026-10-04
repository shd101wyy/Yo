# The static spelling of a generic impl's private method is not E0405-gated — for any module

**Severity:** S3 — the member-visibility rule (`plans/reference/MEMBER_VISIBILITY.md`) is bypassable for every `_`-prefixed method of a GENERIC impl: the instance call `cell._peek()` is rejected with E0405, but the same method in static spelling `Cell(i32)._peek(cell)` compiles from any directory. No wrong runtime behavior — the escape is the API-boundary hole the visibility feature exists to close (the `Mutex(T)._raw_lock`-shaped reach-in).

**Found**: 2026-10-04, while fixing `issues/fixed/prelude-methods-have-no-visibility-owner.md` — its test's second assertion (`MaybeUninit(i64)._probe(m)`, static form) stayed green after the owner stamp landed, and an A/B against a NON-prelude module showed the hole is not prelude-specific. **Status**: OPEN.

## Symptom (measured 2026-10-04, binary built from s3/batch-2-fixes with the prelude-owner fix)

Both shapes use the SAME fixture file `tests/member_visibility/counter.yo` (`Counter` — plain struct, inherent impl; `Cell` — type constructor, `impl(generic(T : Type), Cell(T), … _peek …)`), called from a scratch file in a foreign directory:

```rust
{ Counter, Cell } :: import("../tests/member_visibility/counter.yo");
main :: (fn() -> unit)({
  c := Counter.new(String.from("x"));
  Counter._bump(c, i32(1));        // error[E0405]: Method "_bump" of Counter is private to its declaring module  (rc=1)
});
```

```rust
{ Counter, Cell } :: import("../tests/member_visibility/counter.yo");
main :: (fn() -> unit)({
  cell := Cell(i32).wrap(i32(7));
  Cell(i32)._peek(cell);           // evaluator OK (rc=0) — expected the same E0405
});
```

The instance form of the generic method IS gated (existing test
`generic-impl methods carry their declaring module` → `comptime_expect_error(cell._peek())`
passes), so only the STATIC spelling escapes. Ruled out by probes: the prelude
(same result with a user module), and which module first specializes the impl
(the static call also passes when the specialization is minted by the callee's
own directory through a helper).

## Root cause (verified boundary; inner mechanism suspected, first thing to confirm)

The static spelling is gated by `_reject_private_static_member`
(`src/evaluator/exprs/property_access.yo:263-285`, called at :789 for
primitives and :1133 for the struct/union arm). It reads the FIRST entry of
`get_type_trait_methods_by_name(type_id, prop_name)` — the CONCRETE registry
under the plain type id — and falls back to `type_decl_module(type_id)` when
that entry carries no owner. Suspected mechanism (not traced to the registry
write): a generic impl's members are not registered under the plain type id at
all (they live in the generic-impl registry, `find_methods_from_generic_impls`
in `src/evaluator/values/impl.yo`, whose candidates DO carry the impl's owner),
and the `type_decl_module` fallback misses for a type-constructor instantiation
(the lookup id does not match the id the struct's minting recorded), so `decl`
ends up `.None` and `private_member_blocked` never blocks.

## Fix sketch

Make the static gate consult the same owner the instance gate reads: the
generic-impl registry's candidate owner for receiver `type_val_inner` (the
instance-form check is `_reject_private_method_call`,
`src/evaluator/calls/function.yo:247-296`, whose hits carry the impl's
declaring module), or record the declaring module for generic-impl
specializations where `_reject_private_static_member` looks. Add the failing
test next to the existing generic-impl case in
`tests/member_visibility.test.yo` (`comptime_expect_error(Cell(i32)._peek(cell), "is private")`
against the `counter.yo` fixture, plus the prelude shape
`MaybeUninit(i64)._probe(m)` once the gate works — both asserted today would
stay green, which is why they are not in the file yet).
