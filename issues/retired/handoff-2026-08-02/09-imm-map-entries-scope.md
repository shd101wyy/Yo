## 1. MINIMAL REPRO

`/Users/yiyiwang/Workspace/Yo/scratchpad/t2/v1_empty.yo` (8 lines — smaller than the given repro; **no inserts needed**, an empty map suffices):

```rust
{ assert } :: import("std/assert");
{ Map, Pair } :: import("std/imm/map");
{ List } :: import("std/imm/list");
main :: (fn() -> unit)({
  m := Map(i32, i32).new();
  es := m.entries();
  assert(es.len() == usize(0), "x");
});
export(main);
```

| binary                             | command                         | measured                                                                                           |
| ---------------------------------- | ------------------------------- | -------------------------------------------------------------------------------------------------- |
| `/tmp/sh172` (HEAD)                | `compile … --release -o /tmp/x` | **rc=134**, `get_enum_variant_c_name: no C type name found for enum <enum:enum_yo_id_8100>`, ~65 s |
| `./yo-cli` (TS)                    | same                            | **rc=0**, 2.9 s                                                                                    |
| `/tmp/sclean` (HEAD + patch below) | same                            | **rc=0**; produced binary runs **rc=0**                                                            |

## 2. ROOT

`/Users/yiyiwang/Workspace/Yo/yo-self/types/utils.yo:911` — `_collect_some_types_into` walks `field_types` / `variant_fields` **without resolving struct/enum SHELLS**.

Measured path (lldb backtrace at the abort, `scratchpad/t2/lldb_bt2.txt`):

```
__yo_user_main → generate_all_functions → generate_function_body → generate_other_function_call
  → emit_effect_unwind_check → generate_pending_deferred_drops → generate_drop(`___drop(es)`)
  → generate_drop_code_for_value("es",        <List instance>)      // struct-field arm
  → generate_drop_code_for_value("(es)._head", <Option enum>)       // value-enum arm
  → get_enum_variant_c_name → registry miss → __yo_panic
```

The type on main's `es`:

```
type_key = enum_yo_id_8100_R#struct_yo_id_8098_gs_yo_id_5022_2597_2598_enum_yo_id_8100
stable   = enum_yo_id_8100_None_Some:R#struct_yo_id_8098__value:struct_yo_id_8094_key:K : (…)_value:V : (Send)__next:enum_yo_id_8100
```

so `es` carries the **def-era `List(Pair(K, V))`** (ids 8100/8098/8094), not the concrete era codegen collected (measured `__DBG_CT` dump of every collected key containing Pair's ctor id: `gs_yo_id_5022_i32_i32`, `…_1496_1497`, `…_1513_1514`, `…_1539_1540`, `…_2092_2093` — **`gs_yo_id_5022_2597_2598` never reaches `collect_type`**).

**Why every resolver reports it "already resolved":** `ListNode(T) :: atomic(ref(struct(_value : T, _next : Option(Self))))` is recursive, so a **0-field self-shell** of `ListNode` sits in the `Some` payload. `type_key` (`types/type_key.yo:86`, `:255`) and `stable_type_identity` (`:505`, `:535`) call `resolve_struct_shell`/`resolve_enum_shell` **before** reading fields; `_collect_some_types_into` does not. Measured three independent ways that `get_all_some_types(es_type) == ∅`:

- `__DBG_VAR es somes=` (empty) at `add_variable_to_env`
- `__DBG_DROPARG` never fired at `generate_drop`
- `__DBG_GDV` never fired inside `generate_drop_code_for_value` (while `__DBG_EK drop=DROP:(es)._head` proves that call ran)

Consequently `_resolve_some_types_deep` (`evaluator/types/function.yo:4500`) and `_resolve_type_arg_somes` (`:4691`) — both keyed off `get_all_some_types` / `_collect_type_arg_somes`, neither of which resolves shells — are **blind to this type**. That is exactly why the landed type-argument fix does not reach it. Bonus measurement: `_resolve_type_arg_somes` runs **105 times** in this compile and prints `bound=false` on **every** one (probe `__DBG_TAS`) — it binds nothing in this program.

## 3. TS MECHANISM

TS has no shells: it **mutates the type object in place** while finalizing a recursive type, so `getAllSomeTypes` (`src/types/utils.ts:813-864`) always walks one fully-populated object. yo-self states its own value-semantics equivalent in `yo-self/types/creators.yo:559-568`:

> `yo-self TypeValues are value-typed snapshots, so a leaked shell keeps 0 fields forever (`box.\*.field` on recursive structs like Variable degenerates to unit); the registry lets **field-read sites** swap a 0-field shell for its final form BY ID — the value-semantics mirror of TS's in-place object mutation.`

A SomeT collector **is** a field-read site; it was the one that did not follow the convention.

Also worth recording: the panic _site_ is a yo-self-only divergence. TS's `generateDropCodeForValue` has **no** inline struct-field/enum-variant walk — `src/codegen/exprs/drop-dup.ts:156-163`:

```ts
if (isStructType(concreteType) || isEnumType(concreteType)) {
  const dropFnCName = getDropFunctionForType(concreteType, context);
  if (dropFnCName) {
    return `${dropFnCName}(${valueCode})`;
  }
}
return "";
```

so TS can never call `getEnumVariantCName` from the drop path; for this exact program it emits `fn_yodc526a46_id_939___drop(es)` (`/tmp/t2_entries_ts.c:3303`). yo-self's `get_drop_function_for_type` (`drop_dup.yo:39`, keyed by `type_id_or_empty`) returned `.None`, dropping into the yo-self-only inline walk that panics.

## 4. YO-SELF DELTA

One site. `grep -c '_collect_some_types_into :: (' yo-self/types/utils.yo` → **1** (0 elsewhere).

## 5. PROPOSED PATCH

`yo-self/types/utils.yo:911-917`:

```rust
_collect_some_types_into :: (
  fn(
    ty_in : TypeValue,
    acc : ArrayList(TypeValue),
    visited_ids : ArrayList(String)
  ) -> unit
)({
  // Resolve struct/enum SHELLS before walking — the SAME convention
  // `type_key` (types/type_key.yo:86) and `stable_type_identity`
  // (types/type_key.yo:505) already follow, and creators.yo:559-568 mandates
  // for every FIELD-READING site. A recursive generic (`ListNode(T)`) leaks a
  // 0-FIELD struct shell into its enclosing type, so an unresolved walk sees
  // no fields and reports "no SomeTs" for a type whose rendered key still
  // carries raw SomeT ids.
  ty := resolve_struct_shell(resolve_enum_shell(ty_in));
  match(
    ty,
    …unchanged…
  )
});
```

(`resolve_enum_shell` / `resolve_struct_shell` are already imported at `types/utils.yo:41`; the only other edits are `ty` → `ty_in` in the signature and `)(` → `)({` … `);` → `});`.)

**Validated — measured, not guessed.** Applied to a clean copy at `/tmp/yclean` (only this file differs from HEAD; `./yo-cli fmt --check` clean), built to `/tmp/sclean`:

| gate                                       | HEAD (`/tmp/sh172`)      | PATCH (`/tmp/sclean`)                                                                                                                                             |
| ------------------------------------------ | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `check ./yo-self`                          | 305/305, 0 `error in`    | 305/305, 0 `error in` (docs' "295/305" is stale)                                                                                                                  |
| `check ./std`                              | 153/153                  | 153/153, 0 `error in`                                                                                                                                             |
| `scratchpad/t2/entries.yo` / `v1_empty.yo` | rc=134                   | **rc=0**, runs rc=0                                                                                                                                               |
| all 8 `scratchpad/w5/per/*.yo`             | entries rc=134           | all rc=0                                                                                                                                                          |
| `tests/imm_map.test.yo`                    | rc=0 hollow=1, 21 passed | rc=0 **hollow=1**, 21 passed — **does NOT flip**                                                                                                                  |
| canaries (`test`, hollow-checked)          | —                        | array 12/0, for_macro_borrow 13/0, closure_capture_rc_leak 7/0, imm_string 28/0, arc 15/0, iso 3/0, imm_sorted_map 17/0 (== HEAD), yo-self/tests/types_utils 52/0 |

**NOT run** (be honest): the full 186-file honest sweep, TIER-1 battery, corpus diff-test, stage-2 fixpoint.

## 6. BLAST RADIUS

`get_all_some_types` callers: `evaluator/calls/helper.yo` (30), `calls/function.yo` (14), `values/anonymous_function.yo` (6), `types/function.yo` (4), `expr_info.yo` (2), `calls/function_type.yo` (2), `values/impl.yo`, `types/trait.yo`, `evaluator/types/utils.yo`, `env.yo` (1 each). The change makes previously-invisible SomeTs visible behind recursive-type shells, so gates flip in the "more generic than before" direction: extra specialization/substitution work, the `rte` re-eval fallback firing more often (`helper.yo:2129`), and `is_ret_regression`/`_ctfe_args_equal`-style comparisons seeing longer SomeT lists. Realistic regression modes: (a) a spec that used to be treated as concrete now takes the re-eval path and adopts a different era (the `hashmap_overwrite_no_leak` hazard class); (b) an extra `substitute()` on a cyclic type — the walk already carries the `visited_ids` guard, so no new non-termination is expected, but recursive-type-heavy files (imm_sorted_map/imm_threading, collections/btree_map, json) are the ones to watch. `imm_sorted_map` was measured identical.

## 7. CONFIDENCE + CHEAPEST NEXT OBSERVATION

**High** on the root and the mechanism (each step measured, and the patch demonstrably removes the abort while leaving `check` counts and 7 canaries identical). **Low** on it being safe to land unsweept — one hot predicate changed behaviour globally.

Cheapest observation that settles the rest: run the existing 186-file honest sweep with `/tmp/sclean` (already built) and compare to HEAD's 178/7/0. That single run answers both "does anything regress?" and "does any other file flip?".

Two adjacent, **distinct** bugs found and still open (both TS rc=0):

- `/Users/yiyiwang/Workspace/Yo/scratchpad/t2/C2.yo` (13 lines) — impl-generic method returning `List(K)`; self rc=134 with a **fully concrete** missing key `enum_yo_id_5139_R#gs_yo_id_4973_i32`. Pure era/registration miss; **unchanged by this patch**.
- `/Users/yiyiwang/Workspace/Yo/scratchpad/t2/A_fn_ct.yo` (11 lines) — standalone `fn(comptime(K), comptime(V)) -> List(MyPair(K, V))`; self **rc=139 (SIGSEGV)**.

Also retract-worthy for the notes file: the recorded claim "the instance reaching codegen is GENUINELY UNRESOLVED … the `Pair(K, V)` argument slot holds RAW SomeT ids" is right about the _render_ but wrong about _why nothing fixed it_ — the instance is the whole def-era `List(Pair(K,V))`, and it is invisible to the resolvers because of the 0-field `ListNode` shell, not because the resolvers ran and failed.

Artifacts: repros and all probe logs in `/Users/yiyiwang/Workspace/Yo/scratchpad/t2/`; patched tree `/tmp/yclean`; patched binary `/tmp/sclean`; probe binaries `/tmp/shp2`…`/tmp/shp11` (probe sources in `/tmp/yp2`). No file under `yo-self/`, `src/`, `std/`, or `tests/` was modified (`git status` shows only the pre-existing `M src/tests/fixme.yo`).
