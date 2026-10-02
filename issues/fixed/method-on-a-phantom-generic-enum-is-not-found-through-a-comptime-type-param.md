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

## Fix (2026-10-02, `fix/enum-type-arguments`)

**Status:** FIXED. Measured with a tree-built compiler: the reproducer prints
`5` and `0`. Develop was worse than this doc first said. A generic impl's
method on a phantom enum was not found even when called directly
(`_PhantomTag(i32).A.width()`: "No method "width" on _PhantomTag(i32)"),
because nothing bound `K` from an enum.

The recommendation, in five parts:

- **`TypeValue.EnumT.type_arguments`.** The constructor call that mints an
  enum stamps its arguments on the instance (`calls/comptime_fn.yo`, next to
  the Struct stamp; the innermost constructor wins). `substitute` rewrites
  them like a Struct's. Every reader of the old side table
  (`register_enum_type_arguments` / `lookup_enum_type_arguments`, now
  deleted) reads the field: the CTFE memo key, `iso.yo`'s child walk, the
  higher-kinded binder in the synthesizer, and the compatibility rule.
- **Deferral.** `type_contains_some_type_for_codegen_param` walks them, so
  `t : Tag(K)` defers its helper like `b : Br(K)` does.
- **Impl matching.** `_bind_forall_from_type_args` (`values/impl.yo`) reads
  an enum's type arguments as it reads a Struct's.
- **Type key.** An enum's key and structural signature include each
  PHANTOM type argument, one that occurs in no variant field
  (`_tk_key_occurs_in`, a whole-component match on the rendered keys).
  Before, the abstract `Tag(K)`, `Tag(i32)` and `Tag(bool)` shared one key,
  so the helper called the abstract instance's specialization, which is never
  emitted. Two concrete instances would also share one specialization of a
  method that reads `K` (`sizeof(K)`). A first version added EVERY argument
  and broke the compiler's own emit: "`match` expression enum type has no C
  name". The structural dedup that unifies `rc_fns.yo`'s synthetic `Option`
  (no arguments) with real `Option(T)` instances no longer held. An argument
  in a field is already in the key through that field, so a non-phantom
  enum keeps its key exactly. The occurs check is a structural walk with no
  side effects (`_tk_occurs_in_fields`). Rendering the argument to search
  the field keys touched the key walk's cycle guard and made keys depend on
  walk order. A `Dyn` compares by its trait ids, since `type_to_string`
  spells `Option(Dyn(Error))`'s argument two ways.
  **Measured byte identity:** the compiler's own `src/main.yo`, compiled from
  develop's tree with develop's binary and with this branch's binary (same
  `--std-path`), emits byte-identical C (132 MB, `cmp` clean).
- **Specialization cache.** `_find_specialization_cache` already required
  `type_key` equality for a Struct with type arguments; it now does for an
  enum too. The abstract `Tag(K)` is compat-equal to `Tag(i32)`, since a
  type variable is a wildcard there, so the call-time lookup returned the
  definition-time trial's spec.

`canonicalize_instantiation_via_ctfe_memo` was not needed: with the key
change, the substituted and the minted instance of one instantiation have
one key.

## Performance (measured 2026-10-02)

The first version made `yo check ./src` 4.2x slower (136 s to 573 s), and
codegen-heavy compiles 3x slower. A bisect by toggling each consumer of the
new field found the cause: walking an enum's type arguments a second time,
after its variant fields. `Option(X)`'s argument `X` IS its `value` field, so
for nested enums (`Option(Option(T))`) every extra walk doubled the work per
level. Fixes:
- `substitute` reuses the substituted field for an argument that is
  literally a field type (`types_literally_same`, `types/utils.yo`). It walks
  any other argument only when it contains a type variable.
- The deferral predicate and `iso.yo`'s child walk skip arguments that are
  field types (`enum_arg_is_field_type`).
- The compatibility rule's per-argument check skips them too; their
  difference is already in the fields.
- `type_key`'s occurs check takes the same shortcut first.

After, on the same machine and session as develop:

| | develop | this fix |
| --- | --- | --- |
| `yo check ./src` | 136.4 s | 136.1 s |
| `yo test tests/internal/verifier_match.test.yo` | 153.2 s | 153.7 s |
| `yo compile src/main.yo --skip-c-compiler` | 208.0 s | 209.9 s |

The emitted C for develop's `src/main.yo` is byte-identical.

## Regression test

`tests/comptime_type_arg_binding.test.yo`: "A method on a phantom generic
enum resolves through a comptime type parameter" and "A phantom generic
enum's method that reads K specializes per instantiation". Both fail to
compile on develop with the E0610 above.
