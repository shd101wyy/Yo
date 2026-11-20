# A forced impl member's phase-A flag is lost on its evaluation copy

**Severity:** S2 — a concrete trait impl whose member recurses into itself through another impl's bound (`Box(Self) == Box(Self)` inside `==`) is rejected with E0610 in the trait's default `!=` body; `tests/impl.test.yo` failed to compile on every target after R7.

- Filed: 2026-11-20 (fix-forward lane for develop battery 44642495937 on `69f09baf4`, R7 #2006).
- Status: FIXED by the `fix/develop-r7-battery` PR.

## Reproducer

```yo
{ assert } :: import("std/assert");
SelfEqBoxed :: enum(Tip, Link(next : Box(Self)));
impl(
  SelfEqBoxed,
  Eq(SelfEqBoxed)(
    (==) : (fn(lhs : &Self, rhs : &Self) -> bool)(
      match(lhs, .Tip => match(rhs, .Tip => true, _ => false), .Link(l) => match(rhs, .Link(r) => (l.* == r.*), _ => false))
    )
  )
);
main :: (fn() -> unit)({
  one := SelfEqBoxed.Link(next : Box.new(SelfEqBoxed.Tip));
  assert(one != SelfEqBoxed.Link(next : Box.new(SelfEqBoxed.Link(next : Box.new(SelfEqBoxed.Tip)))), "ne");
});
export(main);
```

`yo check` on `69f09baf4`:

```text
error[E0610]: No matching call found with arguments:
not((Self.(==))(lhs, rhs))
note: raised in the default body of "!=", which trait (...) gives SelfEqBoxed because this impl does not provide it
    --> std/prelude.yo:762:13
```

The v0.2.78 seed accepts it and the program exits 0. The battery saw it as the two wasm32 shards failing on `tests/impl.test.yo` (the native language-suite shards run later in the battery and would have failed the same way).

## Root cause

`l.* == r.*` needs `Box(SelfEqBoxed) : Eq`, whose bound forces `SelfEqBoxed`'s `==` while its own body is being evaluated. `force_in_flight_field` sees the field in state `Forcing`, registers its phase-A FuncVal in the method registry and sets the field's `phase_a_registered` in the in-flight stack. When the body finishes, `_c3_eval_colon_pair` updates that phase-A entry in place instead of registering a second one, but only if `phase_a_registered` is set.

Before R7, `ImplPendingField` was a `ref` record: the field loop's handle and the stack's entry were the same object, so the flag the force set was the flag the completion read. R7 made it a value struct, and `_run_impl_field_in_place` runs the evaluation on a copy taken before the evaluation starts. The completion read the copy's flag, still `false`, and registered a second `==`. The default `!=` body's `Self.(==)(lhs, rhs)` then saw a stale phase-A entry next to the real one and matched neither. The same function's write-back also copied the stale `false` over the stack's `true`. The generic (Case 2) path, `_c2_register_member`, read the same stale copy.

## Fix

The flag is read live from the stack (`impl_in_flight_field_phase_a_at`, `src/evaluator/context.yo`) at the point of registration: `_c3_eval_colon_pair` and the two Case 2 evaluators get the field's `(stack index, field index)` instead of a copy of the field. `_run_impl_field_in_place` no longer writes `phase_a_registered` back, since only `force_in_flight_field` sets it, and it does so in place.

Regression: `tests/impl.test.yo`, "a typed trait member recursing through Box(Self) keeps one registry entry" (and the existing "a trait operator member calls itself recursively" row, which has the same failure).
