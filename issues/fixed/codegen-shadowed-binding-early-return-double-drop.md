# Codegen: early-return cleanup over-drops (the ExprInfo-table UAF) — TWO root causes

**Status: FIXED** (2026-06-11). Root causes of the yo-self "macro-dispatch
corruption" / ExprInfo-table use-after-free
(`issues/yo-self-macro-dispatch-corruption.md`). Two independent
early-return over-release bugs, found via the same lldb + libgmalloc +
`malloc_history` workflow:

1. **Shadowed-binding double drop** (name-vs-identity in the pending-drop
   filter) — the dispatch-OFF deterministic fault. Details below.
2. **Move-into-container + early return** (dup/drop optimizer recorded the
   consume at end-of-scope instead of the transfer site) — the residual
   dispatch-ON SIGTRAP. Details in the second section.

## Symptom chain

- yo-self-bin: intermittent SIGTRAP-in-malloc (exit 133) on `check ./std`
  sweeps (~1/3 of runs with macro dispatch on), deterministic SIGSEGV in
  `__yo_incr_rc ← HashMap(usize, ExprInfo)._find_bucket ← set ←
  expr_info_table_set` under libgmalloc — with dispatch ON **or OFF**.
- Localized via lldb (`DevToolsSecurity -enable`) + libgmalloc +
  `MallocStackLogging=full` + `malloc_history`: the freed 2320-byte block
  was an `ExprInfo` **allocated** in `new_expr_info ←
  evaluate_identifier_and_operator` (evaluating a panic message expr during
  `_trial_eval_fn_body`), stored in the `expr_info_table`, then **freed** by
  a `__yo_decr_rc` issued directly from `evaluate_panic`'s frame while the
  table still held it.

## Root cause (TS codegen, general — not yo-self-specific)

`evaluate_panic` (yo-self/evaluator/builtins/panic.yo) has this shape:

```rust
info_opt := expr_info_table_get(table, id);   // Option(ExprInfo), +1 from get
match(info_opt,
  .Some(info) => {        // BORROW: C binds `info = info_opt.data.Some.value` with NO dup
    ...
    exn.throw(...);       // early-return path (effect escape)
  },
  ...
);
// LATER, same function scope, SAME NAME:
info := new_expr_info(cur_env, return_ty);    // registers a function-scope pending drop for `info`
```

The early-return cleanup blocks (`if (__yo_effect_escaped) { /* Drop local
variables before early return */ }`) are emitted from
`context.pendingDeferredDrops`, filtered in
`src/codegen/exprs/return.ts# generatePendingDeferredDrops` by looking the
drop target's **name** up in the env at the cleanup point:

```ts
const variables = getVariablesFromEnv(expr.$!.env, varName);
const latestVar = variables[variables.length - 1]!;       // ← BY NAME
if (!latestVar.initializedAtToken) return false;
```

At the throw point the function-level `info` is not yet declared, but the
**match-arm binding `info`** (a borrow, never dup'd) has the same name, is
in scope, and is initialized — so the filter let the outer variable's drop
through, and the emitted C `fn_..._drop(info)` resolved to the arm binding.
Result: the arm's payload was dropped **in addition to** `info_opt`'s own
drop → double decrement → the ExprInfo freed while the table still
referenced it. Trial-eval (`_trial_eval_fn_body`) takes throw paths
constantly, so std-scale checks corrupted the table every run; visibility
then depended on allocator churn (macro dispatch added enough to SIGTRAP).

## Minimal reproducer (crashed gmalloc exit 139 pre-fix, exit 0 post-fix)

```rust
Holder :: object(v : String);

f :: (fn(o : Option(Holder), flag : bool) -> i32)({
  r := match(o,
    .Some(h) => {
      cond(flag => { return(i32(1)); }, true => ());
      i32(2)
    },
    .None => i32(0)
  );
  h := Holder(v : String.from("later"));  // same name as the arm binding
  ___ := h;
  r
});
// main: o := Option(Holder).Some(...); f(o, true);  → payload double-freed
```

Emitted C pre-fix (the bug, `drop(h)` resolves to the borrow):

```c
case ..._SOME: {
  __yo_struct_..._3* h = o.data.Some.value;     // borrow, no dup
  if (flag) {
    // Drop local variables before early return
    fn_..._drop(h);                              // ← outer h's pending drop, wrong target
    return ...;
  }
```

## Fix

Match pending-drop targets by **variable identity**, not name:

- `src/codegen/utils/index.ts`: new `getDeferredDropTargetVariableId(dropExpr)`
  — resolves the drop target's `Variable.id` from the drop expression's own
  evaluation env (the scope-exit env of the owning scope, where the target
  is the latest binding of its name).
- `src/codegen/exprs/return.ts`:
  - `generatePendingDeferredDrops` (env-checked branch): find the variable
    in the cleanup-point env **by id**; if absent (only a same-named
    shadowing binding is in scope), skip the drop — the target isn't
    declared yet, exactly what the env check was meant to establish.
  - `generateConsumedVarDropsForEscape`: same identity guard.

## Verification

- Minimal repro: gmalloc exit 139 → 0; emitted C no longer drops the borrow.
- Original reproducer: `DYLD_INSERT_LIBRARIES=/usr/lib/libgmalloc.dylib
  YO_MAIN_STACK_MB=4096 yo-self-bin check std/string/string.yo` —
  deterministic SIGSEGV → exit 0, evaluator OK.
- Regression tests: `tests/shadowed_binding_early_return_drop.test.yo`
  (3 tests: early return through one and two shadowing arm scopes + the
  balanced normal path).
- Gates: `check ./std` 152/152; full `./yo-cli test` suite; yo-self-bin
  sweeps (see the macro-dispatch dossier for the dispatch-on results).

## Root cause 2: move-into-container + early return (dispatch-ON residual)

After fix 1, dispatch-ON sweeps still SIGTRAP'd (~2/3 of `check ./std`
runs). Same workflow, new triple: an `ArrayList(ArgEntry)` (40 bytes)
ALLOC'd in `evaluate_function_call` (`ct_arg_entries :=
ArrayList(ArgEntry).new()`, function.yo:2065), FREED by a direct
`__yo_decr_rc` in the same frame, then USED by `__yo_dispose_dispatch`
when `ct_arg_values` (the `ArgValues` object it was **moved into**,
function.yo:2082) was dropped.

Mechanism: when a local is moved into a constructor (`w := Wrap(items :
items)`), the RC layer first inserts a dup at the use site, then the
dup/drop optimizer (begin.ts `OPTIMIZE_DUP_AND_DROP_PAIRS`) cancels that
dup against the end-of-scope drop and marks the variable consumed — with
`consumedAtToken: lastExpr.token` (end of scope). The early-return-only
drop machinery (`attachEarlyReturnOnlyDropExpressionToReturns`) attaches a
drop to every `return`/`unwind` in the window `[init, consumedAt)` — which
with the end-of-scope token included returns **after** the actual transfer.
Such a return then dropped the moved value while the container still owned
it. (Debug print that cracked it: `var=items init=188 cleanup=335
consumed=381` — consumed pointing at the block's last expr, after the
return at 335, though the real transfer was at ~235.)

Why dispatch-only in practice: the only early return between the
`ArgValues` construction and scope end in `evaluate_function_call` is the
macro-expansion `return(expr)` (function.yo:2154), reachable only when
`fv_is_macro` routes a call through the comptime path.

Fix:
- `src/expr.ts` (dup creation): stamp `__useSiteToken = expr.token` (the
  use site's SOURCE token — the dup expr itself has an auto-generated,
  non-comparable token) on the deferred dup expression.
- `src/evaluator/exprs/begin.ts` (optimizer): when cancelling exactly one
  regular runtime dup (no branch groups), record `consumedAtToken` at the
  dup's `__useSiteToken` instead of `lastExpr.token`. Branch-group/no-dup
  cases keep the end-of-scope token (no single transfer point; preserves
  the early-return drop on every path).

Minimal reproducer (gmalloc 139 → 0): `take_after_move` in
`tests/shadowed_binding_early_return_drop.test.yo` — move an ArrayList
into an object, early-return from a following match arm, then use the
container.

## Collateral discoveries (separate issues)

- `inner := { cond(flag => { return(...) }, ...); i32(20) }` — a block-RHS
  initialization drops its non-tail statements in codegen (pre-existing;
  reproduced on the committed compiler). Filed as
  `issues/codegen-block-rhs-drops-nontail-statements.md`.
- `--sanitize address --allocator libc` produced a binary with **no ASan
  symbols** on this machine (silently uninstrumented) — worth a look at the
  sanitizer flag plumbing.
