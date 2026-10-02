# A generic fn's `Option(U)` result, specialized at an `Option` another call returned, is a second C type

**Severity:** S2. A valid program fails in the C compiler, and `yo check` passes. Any
generic constructor applied to its own result (`wrap(wrap(x))`, `Some` of a `Some` built by
a generic helper) hits it when the outer result flows into a declared `Option(Option(T))`.

**Status:** FIXED 2026-10-02 (`tss/option-of-generic-option-identity`, on top of
`tss/phantom-enum-type-args`). Regression: `tests/generic_instantiation_compat.test.yo`, "a
generic fn applied to its own Option result is the declared Option(Option(T))", and "a nested
generic enum instance is a runtime type".

**Found:** 2026-10-01, by the adversarial review of `tss/generic-extern-trial`. It is not
caused by that branch: its build fails with the same two clang errors as the seed, and the
reviewer found the C byte-identical with the fix switched off. It reproduces on v0.2.43 and
v0.2.48 with the same two clang errors.

## Reproducer

`issues/repros/a-generic-fns-option-result-at-a-specialized-option-is-a-second-c-type.yo`:

```rust
wrap :: (fn(generic(U : Type), x : U) -> Option(U))(.Some(x));
wrap2 :: (fn(x : i32) -> Option(Option(i32)))({
  y := wrap(x);
  wrap(y)
});
```

```
$ yo compile issues/repros/a-generic-fns-option-result-at-a-specialized-option-is-a-second-c-type.yo
error: returning '__yo_t_2204585333134751227' … from a function with incompatible result type '__yo_t_9366833957449532790'
```

The generic form (the reviewer's) adds a second error inside `wrap`'s specialization:

```rust
wrap2 :: (fn(generic(T : Type), x : T) -> Option(Option(T)))({ y := wrap(x); wrap(y) });
```

```
error: returning '__yo_t_2204…' from a function with incompatible result type '__yo_t_1387…'
error: initializing '__yo_t_3927…_tag' with an expression of incompatible type '__yo_t_7931…'
```

## Measured matrix (v0.2.48, `yo compile`, then run)

The body of `wrap2`, with `wrap` as above:

| `wrap2` | result |
| --- | --- |
| `fn(x : i32) -> Option(Option(i32))`, `{ y := wrap(x); wrap(y) }` | C error |
| same signature, `wrap(wrap(x))` | C error |
| same signature, `{ (r : Option(Option(i32))) = wrap(wrap(x)); r }` | C error |
| same signature, `{ (y : Option(i32)) = .Some(x); wrap(y) }` | prints 9 |
| same signature, `Option(Option(i32)).Some(wrap(x))` | prints 9 |
| `fn(generic(T), x : T) -> Option(Option(T))`, `{ y := wrap(x); wrap(y) }` | C error (two) |
| generic, `{ y := Option(T).Some(x); wrap(y) }` | prints 9 |
| generic, `.Some(.Some(x))` | prints 9 |
| no `wrap2`: `main` matches on `wrap(wrap(i32(9)))` directly | prints 9 |

The trigger is the argument of the OUTER `wrap`. When it is the result of another `wrap`
specialization (`Option(U)` with `U := i32`), the outer specialization's `Option(U)` with
`U := Option(i32)` gets a C type distinct from the declared `Option(Option(i32))`. When it
is a declared `Option(i32)`, the two agree. Both C structs have the same layout (a payload
of `__yo_t_7931…`, the one `Option(i32)` C type). Only the key differs. `main` without a
declared result type never compares the two, so it compiles.

## Cause (measured 2026-10-02)

Substitution keeps an instance's definition-era id. Every `Option` instance in the
reproducer, `wrap`'s `Option(U)` at `U := i32` and at `U := Option(i32)` alike, carries the
prelude `Option`'s id (`enum_std__prelude_has_other_aliases_s2_r16c2_n194`). `wrap(wrap(x))`
therefore nests one instance inside another under one id. Four identity mechanisms keyed by the id
alone read that nesting as a cycle:

1. **`type_key`'s cycle guard** (`types/type_key.yo`, `g_tk_visited`). Keying the outer
   instance reached the inner one as a payload, found its id already on the path, and
   rendered it id-only. So the outer `Option(Option(i32))` had the structural signature
   `e_Some=0_None=1_value:<id>`, and the declared `Option(Option(i32))`, whose payload
   expands, had another. A probe on the guard (removed after the fix) printed every enum the
   id-only guard would have cut and the new node expanded instead:
   `…_n194; node …_n194|i32` 15 times for the generic reproducer, and
   `…_n194|s:struct_decl_string__string_String_r0c10(` for its `String` instantiation.
   *Fix:* an enum's path node is its id plus its type arguments' identities (`_tk_node_id`,
   the Struct arm's rule from
   `issues/fixed/a-stream-combinator-used-twice-in-one-chain-emits-two-c-types.md`), and a
   type argument that is an enum renders its own arguments (`_tk_arg_id`). This needs
   `EnumT.type_arguments` (`tss/phantom-enum-type-args`).
2. **`stable_type_identity`** (same file) had the same id-only node. Once (1) gave
   `Option(Option(i32))` and `Option(Option(String))` different keys, both still rendered
   `<id>_Some:<id>_None`, and `collect_type` aliased the second key onto the first's C type
   (`g_stable_to_key`). The generic reproducer called at `i32` and at `String` then failed in C
   with "incompatible integer to pointer conversion". Before (1) the two shared one key, a
   silent merge that the reproducer's first error hid.
   *Fix:* the same node.
3. **The intern key** (`types/intern.yo`): the enum token was `E:<id>`, so `wrap(wrap(i32))`
   and `wrap(wrap(String))` rendered alike past the first level. *Fix:* the token carries the
   type arguments (`_ik_node_token`, now shared by both arms with a tag). A token renders a
   non-nominal argument (`*(Node)`) through the key render's own `visited` set and absolute
   depth. The first build rendered it with a fresh set at depth 0, and every program
   importing `std/env` overflowed the stack: `Option(*(Node))` in `Node`'s field re-entered
   `Node` from inside its own token. The struct tokens had the same latent loop.
4. **The step-4b marker re-derivation guard** (`evaluator/trait_checking.yo`,
   `g_ondemand_marker_guard`, keyed `<id>:<trait>`). Deriving `Runtime` for the outer
   `Option` found the inner one's key already held, so the inner check fell through to
   `false` and `Option(Option(i32))` read as comptime-only. `a := wrap(wrap(n))` (no declared
   type) failed with `Expected "::" instead of ":="` and `Type: Option(U)`
   (`issues/fixed/a-nested-generic-enum-instance-reads-as-comptime-only.md`). *Fix:* a
   generic enum keys by `enum_instance_node_id`.

The hypothesis this doc was filed with (the cycle guard) was right. Measured: it is
one of four sites, not the only one.

The reproducer had a third failure. With the generic `wrap2` and the non-generic one in the
same program (any order), `check` rejected the generic one:
`E0604: Incompatible function return type … Expected: Option(Option(T)), Given: Option(U)`.
That holds on v0.2.48 and on the base. The branch fixes it (measured, `check` exits 0). It
was not attributed to one of the four sites.

## Verification

- The reproducer prints 9. The generic form at `i32` and at `String` in one program prints both
  values, and `wrap(wrap(wrap(x)))` into `Option(Option(Option(i32)))` prints its value too.
  The base compiler (`tss/phantom-enum-type-args`) fails each of these in the C compiler or
  with the `::` error.
- Byte identity: not byte-identical, and the difference is a renaming. `src/main.yo` was
  emitted with `--emit-c --skip-c-compiler --optimize 2 --std-path ./std` on the base tree,
  by the base compiler and by this branch's compiler. Both files have 1,822,222 lines,
  2,169 distinct `__yo_t_*` types, 5,337 `__yo_fs_*` and 6,316 `yo_id_*` function names.
  Renamed: 74 type names, 245 `__yo_fs_*` names and 13 `yo_id_*` names. With those three
  name families and the `_temp_<n>` counters normalized, the two files hold the same
  multiset of lines. Cause: a type
  whose key reaches a generic enum instance nested in another instance of the same enum
  used to key the inner one id-only. Example: `yo_id_7720…`'s key had
  `aggregate_ty_enum_…_n361_ty_name` and now has
  `aggregate_ty_enum_…_n361_value_enum_decl_types__definitions_TypeValue_r1c2_ty_name`.
  `EvalValue`'s key is one of these, so every type keyed through `EvalValue`
  (`SpecializingFunctionInfo`, `EvalContext`, …) and every specialization name that embeds
  one changes too. A C name is a hash of its key, and declaration order and temp counters
  follow the names.
