# An unknown name as a type argument in a typed binding reports "Expected comptime" instead of E0401

> Found 2026-09-24 while writing a reproducer for
> `issues/fixed/match-or-cond-call-argument-result-is-never-released.md`.
> FIXED 2026-09-28 (see Resolution). Belonged to `plans/TYPE_SYSTEM_SOUNDNESS.md` Phase 4 (diagnostics).

## Reproduction (v0.2.41 seed and develop b9619889b)

```rust
{ ArrayList } :: import("std/collections/array_list");
main :: (fn() -> unit)({
  (keys : ArrayList(Strin)) = ArrayList(Strin).new();
  _n := keys.len();
});
export(main);
```

```
error: Expected "comptime" for compile-time known value binding:
Comptime
  --> diag4.yo:3:4
  |
3 |   (keys : ArrayList(Strin)) = ArrayList(Strin).new();
  |    ^^^^
```

The same happens at module level (`(g_keys : ArrayList(Strin)) = ...`) and
for a real type that is simply not imported (`ArrayList(String)` without
`{ String } :: import("std/string")`), which is how it was hit: the message
sends the reader looking for a comptime/runtime problem on the binding, when
the fix is an import. A bare unknown name in a call (`println` without its
import) correctly reports E0401 with the import hint.

## Expected

`error[E0401]: Variable "Strin" not found.` pointing at the type argument,
with the did-you-mean / import help the other E0401 sites give.

## Notes

Not investigated further. The binding's type annotation is evaluated through
the comptime-type path; the lookup failure of the argument apparently
surfaces as an unknown comptime value, and the typed-binding check then
reports the comptime mismatch instead of the original lookup error.

## Resolution (2026-09-28, branch `tss/p6-generic-reraise`, Phase 6 census site #16)

The lookup error for `Strin` was swallowed by the per-node wrapper (the 3-argument
`evaluate_expression`) while the type-constructor call evaluated its arguments, and the degraded
result typed the annotation `Comptime`. With the Phase 6 conversion of the per-node swallow sites
to `evaluate_expression_raw(…, exn)` / `evaluate_expression_guarded`, the original E0401 reaches
the user, at the type argument. Test:
`tests/cli-cases/check-unknown-type-argument-in-a-typed-binding-is-e0401`.
