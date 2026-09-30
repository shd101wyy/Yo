# A method on a phantom generic enum is not found through a `comptime(K) : Type` parameter

**Severity:** S3 — a valid program is rejected with "No method". A module-level helper function that takes the enum is the other spelling, and no std type needs the shape today.
**Found:** 2026-09-30, extending the regression test of `issues/fixed/method-on-a-phantom-generic-struct-is-not-found-through-a-comptime-type-param.md` from structs to enums (`plans/EXPLICIT_ALLOCATORS.md` P3b).

## Reproducer

```rust
{ println } :: import("std/fmt");
Tag :: (fn(comptime(K) : Type) -> comptime(Type))(enum(A, B(n : u8)));
impl(generic(K : Type), Tag(K), code : (fn(self : Self) -> u8)(match(self, .A => u8(0), .B(n) => n)));
helper :: (fn(comptime(K) : Type, t : Tag(K)) -> u8)(t.code());
main :: (fn() -> unit)({
  t := Tag(i32).B(n : u8(5));
  println(helper(i32, t));
});
export(main);
```

```
error[E0610]: No method "code" on Tag(K): the type has no field or method with that name.
```

## Cause

The struct twin of this bug was a deferral decision. The helper was checked eagerly
against the abstract `Tag(K)`, because the predicate that decides deferral saw no
type variable in the parameter type. For structs the fix is to walk
`type_arguments`. An enum has no such field. Its instantiation's arguments live in
a side table keyed by enum id (`register_enum_type_arguments`,
`src/types/creators.yo`), and that table goes stale under substitution.
`substitute` rewrites an instance's variant fields but keeps its id, so a
substituted instance reads back its definition-era arguments. `?(*(u8))` reports
`[*(T)]`, as `src/types/compatibility.yo` already records.

Consequences measured on a debug build:

- **Walking the side table in the deferral predicate breaks every program.**
  `hello world` failed to compile, because `?(*(u8))` instances in the prelude
  then counted as generic and their functions were skipped by codegen.
- **Walking only phantom positions gets past the evaluator.** Those are positions
  whose variable occurs in no field, decided once per constructor from a
  definition-era instantiation. The impl then matches `Tag(i32)` at the call. But
  the emitted helper calls the specialization of `code` for the definition-era
  instance, which is never emitted:

  ```
  error: call to undeclared function 'yo_id_…_rtparam0_enum_…_PhantomTag_r0c58_n1_n_u8_ret_u8'
  ```

  With no field to substitute, `Tag(K)` with `K := i32` stays the same instance
  (`_n1`), so the specialization is keyed on it. A struct gets a new instance
  because substitution rewrites its `type_arguments`, and
  `canonicalize_instantiation_via_ctfe_memo` then finds the memo's concrete one.

## Recommendation

Give `TypeValue.EnumT` a `type_arguments` field, filled where
`register_enum_type_arguments` is called today and rewritten by `substitute` like
the Struct arm. Then extend `canonicalize_instantiation_via_ctfe_memo` and the
deferral predicate to enums the way they handle structs. The side table and its
staleness caveats go away with it. This touches every `.EnumT(...)` pattern, so it
is its own change and not part of the explicit-allocators stack.
