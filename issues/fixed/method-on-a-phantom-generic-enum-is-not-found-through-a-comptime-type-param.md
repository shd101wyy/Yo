# A method on a phantom generic enum is not found through a `comptime(K) : Type` parameter

**Severity:** S3 — a valid program is rejected with "No method". A module-level helper function that takes the enum is the other spelling, and no std type needs the shape today.
**Found:** 2026-09-30, extending the regression test of `issues/fixed/method-on-a-phantom-generic-struct-is-not-found-through-a-comptime-type-param.md` from structs to enums (`plans/archive/EXPLICIT_ALLOCATORS.md` P3b).

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

(Kept as filed; the fix below follows it, with the measured deviations.)

Give `TypeValue.EnumT` a `type_arguments` field, filled where
`register_enum_type_arguments` is called today and rewritten by `substitute` like
the Struct arm. Then extend `canonicalize_instantiation_via_ctfe_memo` and the
deferral predicate to enums the way they handle structs. The side table and its
staleness caveats go away with it. This touches every `.EnumT(...)` pattern, so it
is its own change and not part of the explicit-allocators stack.

## Fix

`TypeValue.EnumT` carries `type_arguments : ArrayList(Self)` (the last
field; every positional `.EnumT(...)` pattern and constructor in `src/` and
`tests/internal/` was updated, 186 sites). The id-keyed side table
(`register_enum_type_arguments` / `lookup_enum_type_arguments`,
`src/types/creators.yo`) is gone, and so are its staleness caveats.

- **Stamp.** The comptime-fn call site (`evaluator/calls/comptime_fn.yo`)
  stamps the returned enum's `type_arguments` when they are empty and the enum
  was minted in CTFE (not an `enum_decl_` alias result), the same rule the
  side table had ("the innermost constructor that minted the enum wins").
  The enum-final registry's copy is stamped too
  (`stamp_enum_final_type_arguments`), so a leaked self-shell resolves to an
  instance that reports the same arguments.
- **Substitute.** `substitute`'s EnumT arm rewrites an argument that is a
  type variable, and every argument at a phantom position (below). Any other
  compound argument keeps its definition-era spelling (`?(*(u8))` still
  reports `[*(T)]`): it also occurs in a payload, which the walk already
  rewrites, and walking it a second time doubled the work at every nested
  instantiation (see the deviations). A phantom position occurs in no
  payload, so walking it is not a second walk. `_patch_self_shell` patches the
  arguments too. Interning (`types/intern.yo`) keys them, since a substituted
  phantom instance differs from its definition-era original only there.
- **Readers.** `compatibility.yo`, the CTFE memo's era comparison,
  `synthesizer.yo`'s higher-kinded binding and `iso.yo` read the field.
  `_bind_forall_from_type_args` (`values/impl.yo`) binds an impl's `generic`
  parameter from an enum's arguments as it does from a struct's.
- **Phantom positions.** A concrete `Tag(u8)` cannot tell from its payloads
  which arguments are phantom (`B(n : u8)` spells `u8` too), so the
  constructor decides. Its definition-time trial evaluates the body with each
  type binder bound to a SomeT. When the body is an enum, a position whose
  SomeT occurs in none of the payloads is phantom
  (`_record_ctor_phantom_positions`, `evaluator/calls/function_type.yo`,
  recorded once per constructor by `register_ctor_phantom_positions`,
  `types/creators.yo`). That is a fact about what the enum depends on, not
  about what the body spells: `enum(A, B(n : _Discard(K)))`,
  `{ _k :: K; enum(A, B(n : u8)) }` and `enum(A, K(n : u8))` all leave `K`
  phantom. A first version decided it from spelling and printed one
  instantiation's `sizeof(K)` for all of them
  (`issues/fixed/phantom-positions-decided-by-spelling-share-one-method-specialization.md`).
  A constructor with no record, or a position past it (a variadic argument),
  counts as phantom (`ctor_phantom_flags`). The stamp records the flags by
  enum id (`enum_phantom_positions`), for the instance and its finalized form.
  Substitution keeps the id, and phantomness is a fact about the constructor,
  so the record cannot go stale. Separately,
  `enum_phantom_type_arg_somes` (`types/utils.yo`) returns the arguments at
  phantom positions, plus any type-variable argument no payload mentions. The
  deferral predicate (`type_contains_some_type_for_codegen_param`) and the
  type-argument SomeT collector (`_collect_type_arg_somes`) walk what it
  returns. The collector is the return-type era repair's trigger and the
  specialization cache's `type_key` guard. It takes every SomeT of a compound
  phantom argument (`Option(K)` of `Tag(Option(K))`). Without that, a concrete
  call reused the abstract specialization a definition-time trial had
  registered
  (`issues/fixed/a-compound-phantom-enum-argument-reuses-the-abstract-method-specialization.md`).
  Arguments that a payload mentions are left alone: the payload walk already
  sees them, and re-evaluating a `-> Option(V)` return is a recorded hazard
  (`calls/function.yo`, rre).
- **C type key.** `type_key` keys an enum's phantom arguments (`_ph:<key>`):
  every non-`Unit` argument at a phantom position, resolved through its cell
  chain, and any unresolved type-variable argument no payload mentions. The
  key had been payloads only, which had two consequences. The specialization
  of `code` that a definition-time trial registered over the abstract
  `Tag(K)` was the one the concrete call reused, and codegen never emitted it
  (the second measured consequence above). And `Tag(u8)`, `Tag(i64)` and
  `Tag(i32)` were one C type, so they shared ONE specialization of every
  method (each runtime parameter is keyed by `type_key`): a body reading `K`
  (`sizeof(K)`) printed `1 1 1` for the three. A first version of this fix
  keyed only unresolved type variables and had exactly that miscompile.
  An enum with no phantom position keys as before.

### Deviations from the recommendation, measured

- **`canonicalize_instantiation_via_ctfe_memo` stays struct-only.** Extending
  it to enums broke `tests/type_soundness.test.yo`'s "a ref struct's
  Option(Self) survives a generic specialization": with a preceding test that
  declares another same-shaped `ref(struct(n : i64, memo : Option(Self)))`,
  the caller's local for `l.get(usize(0))` took that other struct's `Option`
  C type (`incompatible pointer types` from clang). Reverting the enum arm
  fixed it. An enum needs no era repair there, because its C type is keyed by
  its payloads.
- **Walking every type argument is too slow.** A first build walked all of an
  enum's arguments (with `get_all_some_types`) in `type_key`, in the
  collector, and compared arguments for one id in `compatibility.yo`. The
  stage-2 emit of `src/main.yo` was still running after 24 minutes at about
  1 GB resident, against 9 min 19 s for the develop build (killed). The
  phantom-only walk runs the payload scan only when an argument is itself a
  SomeT. `compatibility.yo` keeps its `aid != eid` guard, so two instances of
  ONE id that differ only in a phantom argument are still compatible there.
  A generic return whose phantom argument is the type variable itself
  (`-> _Phantom(T)`) does not produce such a pair, because the return-type
  era repair now re-evaluates it (see
  `issues/fixed/a-substituted-phantom-enum-instance-flows-into-any-instantiation.md`).
  Generic inference through phantom arguments is still open
  (`issues/generic-inference-ignores-phantom-type-arguments-of-structs-and-enums.md`).
- **Walking all arguments also changed abstract C types.** Keying any
  abstract argument renamed the C type of the abstract `?(*(T))`, which
  appears in emitted C. Only phantom positions are keyed now.

### Verification

Measured on `158bac145` (the binary built from it; the earlier numbers in
this section were for `af6589233` and are superseded).

- `tests/comptime_type_arg_binding.test.yo` gains four enum cases: the
  reproducer, per-instantiation specialization (`sizeof(K)` for `u8`, `i64`,
  `i32`), a compound phantom argument (`_PhantomTag(Option(K))`), and the
  three constructors that spell `K` without depending on it. With the
  develop-built compiler the batch fails (E0610, `No method "code" on
  _PhantomTag(K)`); with the `3705a7e25` build it fails in the C compiler (0
  of 9 ran). The fixed build passes 9/9. Run as standalone programs, the
  spelling cases printed `1 1`, `1 1 1` and `1 1` with the `3705a7e25` build
  and print `1 8`, `1 8 4` and `1 8` now.
- `tests/type_soundness.test.yo` gains the substituted-instance case. It fails
  with the develop-built compiler (the expected `Incompatible types` is not
  raised) and passes after (62/62).
- `check ./std` 177/177 and `check ./src` 278/278 pass.
- The stage-2 C of the compiler itself is byte-identical. `compile src/main.yo
  --emit-c --skip-c-compiler --std-path ./std` on the develop tree
  (`5567a7796`) gives the same 131,445,189-byte file (sha256
  `cd26d114…f212cd`) from the develop-built compiler and from this one. On
  this branch's tree the two compilers again agree byte for byte
  (131,550,422 bytes, sha256 `c925cd18…14db41`). Emit cost on a loaded shared
  machine, two emits running at once: this compiler 25 min 31 s on the develop
  tree and 25 min 51 s on this tree, 2.93 GB peak RSS each; the develop-built
  one on this tree 22 min 54 s (alongside `check ./src`), 2.92 GB.
