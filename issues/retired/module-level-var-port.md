> **RETIRED (2026-08-06).** Superseded record — reverted-patch snapshot; the port landed since (yo-self/codegen/exprs/generation.yo emit_module_level_variable_declarations).

# Module-level mutable-variable emission port (stage-2 fixpoint)

**Status:** Feature ported end-to-end and validated _mechanically_ (builds, corpus
97/97 green, self-compile completes exit 0, 11 decls + init helper emitted). But it
does **not** net-reduce stage-2 clang errors yet — it is **gated on generic-instantiation
type-identity consistency**. Reverted to keep the green baseline; the full port is
saved in `issues/patches/module-level-var-port.patch` (`git apply` to restore).

## What the port does (faithful to TS)

TS pipeline (for reference):

- `evaluator/values/anonymous-module.ts:383-416` — each module's eval collects its
  module-level **mutable** var init exprs onto `moduleValue.moduleLevelInitExprs`.
  Filter: `:=` → LHS atom, has `.type`, **no** `.value` (runtime var); `=` → the
  assigned var is `isModuleLevel` in env.
- `module-manager.ts:419-425` — aggregates `allModuleLevelInitExprs` across ALL
  loaded modules.
- `codegen/types/collection.ts:138-144` — `collectTypesFromExpr(initExpr)` (whole
  expr) registers referenced types incl. the **LHS-atom type**.
- `codegen/functions/generation.ts:782-831` — `emitModuleLevelVariableDeclarations`
  emits `static <cType> <cName>;` using the **LHS-ATOM's type** (`varAtom.$.type`),
  NOT the RHS type.
- `generation.ts:997-1092` — a `__yo_main_module_init(void)` helper (POSIX) runs the
  init assignments first on the worker thread (`if (__yo_effect_escaped) return;`);
  non-POSIX inlines them into `main()`.

yo-self port (in the patch):

- `codegen/functions/generation.yo` — `ModuleLevelVar`, `g_module_level_init_exprs`
  (aggregated side-table, single-threaded-safe like `g_traverse_visit_expr`),
  `reset_module_level_init_exprs`, `add_module_level_init_exprs(exprs, info)` (faithful
  `:=`/`=` filter via ExprInfo `.env`/`.value`), `_module_init_var_atom`,
  `emit_module_level_variable_declarations` (LHS-atom type), `module_level_init_exprs`
  read-accessor (a mutable global can't be `export`ed — only compile-time vars can),
  and the `__yo_main_module_init` helper injected into `generate_main_wrapper`.
- `codegen/codegen_c.yo` — after `collect_required_types`, register each global's OWN
  LHS-atom type via `collect_type(ei.ty)` (see the key finding below); emit the decls
  before `generate_main_wrapper`.
- `main.yo` — `reset_module_level_init_exprs()` at compile start; `add_module_level_init_exprs`
  inside `_eval_module_exprs_capturing_error` gated on `g_shared_expr_info_table.is_some()`
  (compile mode only; covers loader-loaded imports + entry module).

## Key findings from the build cycles

1. **Type source MUST be the LHS atom, not the RHS** (`generation.ts:820`). The first
   attempt used the RHS ExprInfo type → wrong.
2. **Collection MUST NOT walk the whole init expr in yo-self.** TS does
   `collectTypesFromExpr(wholeExpr)`, which works because TS type identity is
   structural/stable. In yo-self it pulls in **mis-keyed generic-instantiation
   intermediates** and crashes `get_type_string` (SIGABRT) on e.g.
   `enum_yo_id_3869_struct_yo_id_240330` — an `Option`-over-**value-struct** (empty
   name, 2 variants) that `can_optimize_as_nullable_pointer` rejects and whose
   registration key ≠ lookup key. Fix: collect only each global's own **LHS-atom type**
   via `collect_type(ei.ty)`. → self-compile then completes exit 0.

## The real blocker (why it doesn't help yet)

With the LHS-atom-only collection, stage-2 compiles (exit 0) and emits 11 decls, but
the clang error count goes **1627 → 1762**:

- `use of undeclared identifier`: **733 → 689** (−44) — the decls DO help.
- `initializing ... with incompatible type`: **+241** — registering the globals' generic
  struct types (e.g. `BuiltinYoInlineFunctions`'s HashMap-like type) surfaces the
  **generic-instantiation type-identity inconsistency** broadly: the declared type's
  C-name/key does not match the use sites' expected type, converting clean
  "undeclared" errors into "incompatible type" cascades.

This is the **same root** as the `enum_3869` crash and the long-standing
generic-instantiation identity family (see memory: struct-identity cache collision,
comptime-fn cache, Phase-3 funcId). **The module-var feature is complete; it cannot
net-improve the fixpoint until generic-instantiation type keys/C-names are consistent
between a type's declaration/collection and its use sites.**

## The blocker, localized to exact sites

`type_key` (`yo-self/codegen/utils/index.yo`) keys a **struct** in its `.Struct` arm:

- **line ~755** — GENERIC INSTANTIATION with stable identity: `gs_<constructor_func_id>_<typeargs>`,
  taken ONLY when `constructor_func_id` is non-empty AND `type_arguments` non-empty AND depth≤4.
- **line ~781** — no cfid: look up `g_struct_cfid_keys[sid]`, else fall back to the bare
  `sid` (an UNSTABLE per-instantiation id).

`constructor_func_id` is stamped onto a generic struct instantiation at
`yo-self/evaluator/calls/comptime_fn.yo:872` (when a type-constructor comptime call returns
a `Struct` with empty cfid, it rebuilds it with `func_id_str` + `inst_type_args`).

**The divergence:** the same logical `Option(struct_240330)` reaches `type_key` with the
payload struct carrying cfid at one site (→ `gs_...` key) but empty at another (→ bare
`struct_yo_id_240330`), because some path that produces the generic struct instance does NOT
route through the comptime_fn stamping (candidates: `types/substitution.yo:222`,
`resolve_struct_shell`, or a field-type copy). The enum's structural sig then embeds the
payload key, so the two sig variants map to two canonical enum C-names → the mismatch.

**Fix direction:** ensure `constructor_func_id` + `type_arguments` are populated on EVERY
generic struct instantiation (so the `gs_` path is always taken), OR make the bare-sid
fallback reconcile structurally. NOTE (memory `yo-self-phase3-generic-impl-funcid`): a prior
attempt at this was reverted (dead `evaluate_comptime_fn_call` + TypeValue-clash + possible
struct-clone-id-churn) — it may need a dedicated `Struct` field, so treat as a careful
standalone task, validate with corpus 97/97 + `check ./std` 152 at each step.

## Next step

Fix the cfid-population consistency above FIRST. Then `git apply
issues/patches/module-level-var-port.patch`, rebuild, corpus-gate 97/97, and the decls become a
clean win (undeclared drops with no incompat cascade). This same fix should also cut into
the baseline 1627 stage-2 errors directly (many are the same incompat-type family).
