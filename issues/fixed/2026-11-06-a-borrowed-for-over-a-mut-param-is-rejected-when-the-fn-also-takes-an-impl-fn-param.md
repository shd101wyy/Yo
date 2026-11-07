# A borrowed `for` over a `&mut` param is E0926 when the fn also takes an `Impl(Fn)` param

**Severity:** S1 — a legal fn shape is unwritable (every spelling of the loop is
rejected), and it blocks `check ./src` (85 of 274 files fail through
`src/evaluator/shared/suspension_analysis.yo:668`) under N3's deref adoption
(v0.2.76 hard-gate lane `vbd/deref-adoption`). G1's ~35 `&mut Impl(FnMut(...))`
slot switches will meet the same rejection at scale. The same root cause also
miscompiled silently (below): a by-value `match(m.*, …)` wrote the caller's
value, and a receiver probe picked the other impl.

Filed 2026-11-06 on `vbd/deref-adoption` (f47ff53df), reproduced with the
T_del2 binary (the branch's `1d0b723df` build; any tree binary carrying the
`is_deref_rule_exempt` deletion). Reproduced 2026-11-07 on develop 142a2f972,
which has the deref rule for user files. Fixed 2026-11-07 on
`fix/borrowed-for-over-mut-param-with-fn-slot`.

## Verbatim error

```
error[E0926]: `m` is a reference (`&mut ArrayList(String)`): borrowing the value it refers to is spelled `&m.*`
   --> tmp/dfor10.yo:10:10
10 |   for(&m.*, k => {
   |          ^
help: write `&m.*` (or `&mut m.*`), or pass `m` itself to a reference parameter
```

The site IS spelled `&m.*`: the diagnostic asks for the spelling the source
already has. On develop the error carries one more line,
`note: in \`walk10\`, instantiated here`, at the call `walk10(h, idc)`.

## Minimal reproducer

```yo ignore
{ ArrayList } :: import("std/collections/array_list");
{ String } :: import("std/string/string");
walk10 :: (
  fn(
    m : &mut ArrayList(String),
    g : &Impl(Fn(x : &i32) -> i32)
  ) -> usize
)({
  mut(n) := usize(0);
  for(&m.*, k => {
    n = (n + usize(1));
  });
  n
});
idc :: (fn(x : &i32) -> i32)(x.*);
caller10 :: (fn(h : &mut ArrayList(String)) -> usize)(walk10(h, idc));
export(caller10);
```

`yo check` on that file fails. It passes if EITHER the `g` parameter is removed
OR the loop is rewritten (the `m.clone()` value form).

## The shape is unwritable: every spelling rejected

With an `Impl`-typed parameter present (`&Impl(Fn(...))` or
`&mut Impl(FnMut(...))`), a borrowed `for` over another `&mut` parameter
failed in every spelling (all probe-verified on T_del2, files
`tmp/dfor10..17.yo`):

- `for(&m.*, ...)`: E0926, the false positive. `&mut m.*` fails the same way.
- `for(&m, ...)`: E0926. This rejection is correct.
- `for(m, ...)` (bare scrutinee): E0901, a copy of the move-only referent.
- An explicit capture list on the loop closure: E0901 ("cannot copy `m`").

Without the `Impl` param the first spelling was accepted everywhere
(`tmp/dfor1..9.yo`).

## Blast radius

- `src/evaluator/shared/suspension_analysis.yo:668`, in `walk_expr_`.
  `get_info : &Impl(Fn(e : &AstExpr) -> Option(ExprInfo))` is its second
  parameter, and the `for(&name_frame_to_original_id.*, ...)` snapshot loop is
  its one borrowed `for`. Every `check ./src` entry file that imports it (85 of
  274) reported the E0926.
- The trigger was wider than `Impl` parameters and wider than `for`. The list
  is in "What else it hit" below.

## Root cause

The `Impl` parameter mattered only because it makes the function specialized
per call. What failed was the specialization's copy of the body.

1. N1e-1 (decision 43 step 2) evaluates a written `m.*` on a reference binding
   `m` as the name `m`. `evaluate_property_access`
   (`src/evaluator/exprs/property_access.yo`) records the `.*` node as
   rewritten to the atom `m`, keeping the node's id, with the atom's token at
   the `*`'s position (`note_rewritten_node`, `src/expr.yo`). It also notes
   that position as a deref site (`note_reference_deref_site`). Codegen and any
   re-evaluation of the same ids read the node through `ast_rewritten_node`, so
   both see the bare read the deref lowers to.
2. A function with an `Impl(...)` parameter takes the concrete
   definition-time trial (`[flow-post]` under `YO_DEBUG_SWALLOW=1`). That trial
   evaluates the body's ORIGINAL ids and records the rewrite above. The
   function is then specialized at each call, because the slot's closure type
   is the call's. `create_specialized_function_inline`
   (`src/evaluator/calls/helper.yo`) evaluates a fresh-id clone of the body.
3. `clone_expr_fresh_ids` (`src/expr.yo`) cloned every node THROUGH
   `ast_rewritten_node`. The clone therefore contained the bare atom `m` where
   the source says `m.*`: the rewrite became source text. Every shape judgment
   in the specialization then saw `m`. The local-borrow evaluator saw
   `for_coll := &m` with no `*` hop (`_evaluate_inout_local_binding`, the
   kind-2 E0926 above).

The written-star machinery (`_is_written_star`, `is_synthesized_deref_star`)
and the three kind-2 callers that the filing named as candidates were not
involved: the star never reached the clone.

The same three steps explain every trigger seen:

- **A generic function whose result names its type variable** (`-> T`).
  `dg_check_result` makes its deferred trial evaluate the original ids
  (`body_expr.clone()`), and its specializations clone the body. A generic
  `-> usize` passed, because its trial already ran on a fresh-id clone and
  recorded nothing under the original ids.
- **`check --watch` revalidation.** A per-def round re-forces the unchanged
  dependents of an edited definition from `clone_expr_fresh_ids` copies
  (`src/module_manager.yo`). A body-only edit of `helper` therefore failed the
  unchanged `walk` (`y := &m.*; (y.len() + helper())`) with E0926. No `Impl`
  parameter and no generics were involved.
- **A trait default's per-impl materialization** clones the default's body
  (`src/evaluator/values/impl.yo`). This is the path behind
  `issues/fixed/2026-11-05-a-capture-list-in-an-untyped-trait-default-lambda-cannot-borrow-self.md`.
  That fix taught the capture-list check to accept the materialized atom
  (`is_reference_deref_site`). Here the atom no longer reaches the clone.

## What else it hit (probe-verified on develop 142a2f972)

Each case below is a function that also takes `g : &Impl(Fn(x : &i32) -> i32)`,
compared with the same function without `g`:

| body | without `g` | with `g` (before the fix) |
| --- | --- | --- |
| `y := &m.*; y.len()` | accepted | E0926, kind 2 |
| `match(&m.*, .Some(s) => s.len(), …)` | accepted | E0926, kind 3 ("the borrow marker is redundant") |
| `match(m.*, .Some(mut(c)) => { c.bump(); c.n }, …)`, `Copy` payload | caller unchanged (`o.n=5`) | **wrote the caller** (`o.n=6`): the clone's `match(m, …)` matched through the reference |
| `m.*.peek()`, with `impl(Tick, peek)` and `impl(&mut Tick, peek)` | `impl(Tick)` (`r=5 o=5`) | **`impl(&mut Tick)`** (`r=105 o=105`) |
| `t := T(n : m.*); (&t).who()`, with `impl(T)` and `impl(&T)` | `impl(&T)` (`r=2`) | **`impl(T)`** (`r=1`): the clone copied the stripped receiver `t.who` without its `(&t)` mark (`g_explicit_ref_receivers` is keyed by the original callee id) |
| `v := ident(m.*)`, a generic identity | accepted | E0901: the binder read the reference itself (R1's read rule) |

The `(&t).who()` row is a second rewrite, N1f-2's explicit-receiver strip
(`_strip_explicit_ref_receiver`, `src/evaluator/calls/function.yo`), which
reaches the clone the same way.

## Fix

`clone_expr_fresh_ids` clones the WRITTEN tree: it no longer reads nodes
through `ast_rewritten_node`. Every consumer of a fresh-id clone evaluates it
(a specialization's body, a watch revalidation, a trait default's
materialization, an overload dry-run, a macro expansion, a contract
predicate), and that evaluation re-derives each type-directed rewrite under the
clone's own ids, the auto-dereferences included. A generic function's
fresh-clone deferred trial has always worked this way. The original ids keep
their recorded rewrites for codegen and for re-evaluations of the same ids,
which still read through `ast_rewritten_node`. The `g_rewritten_nodes` doc
comment now names the clone as the one reader that does not.

No judgment site changed. A specialization's `&m.*` reaches the local-borrow
evaluator with its `*` hop again, `match(m.*, …)` reaches the match evaluator
as a by-value match of the referent, and `(&t).who()` re-runs the strip and
re-records its mode under the clone's callee id.

### CTFE leaned on the copied rewrite

Cloning the written tree exposed one place that only worked because of the
copied rewrite: compile-time function evaluation. CTFE binds a `&T` / `&mut T`
parameter as a compile-time value of its pointee, both in the capability
analysis (`_eval_body_for_ctfe`, `src/evaluator/ctfe/ctfe_analysis.yo`) and in
a compile-time call (whose callers bind the comptime version's parameters). A
compile-time binding is not a reference binding
(`variable_is_reference_binding`), so a written `y.*` fell through to the old
payload reading and failed on an `i32`
(`[pa-fallthrough] prop=* obj_ty=i32` under `YO_DEBUG_CTFE=1`). On the clone
alone, `comptime_fn(outer)` over a nested `helper :: (fn(y : &i32) -> i32)(y.* + i32(1))`
emitted an undeclared `__yo_v_r`, and `comptime_fn(add1)` over the same
function at module level was rejected ("Failed to create compile-time
version"). Both fold to 21 on develop, and only because the clone carried the
definition-time `y.*` → `y`. A generic nested helper, whose trial never
rewrote the original ids, failed the same way on develop.

CTFE now records each compile-time binding of a reference parameter
(`note_ctfe_reference_params`, called by `_eval_body_for_ctfe` and by
`evaluate_comptime_fn_call`, into `g_ctfe_reference_params` in
`src/evaluator/utils.yo`). N1e-1's `.*` reading accepts such a binding beside
a reference binding (`is_ctfe_reference_param`,
`src/evaluator/exprs/property_access.yo`). `variable_is_reference_binding`
and the E0926 judgments are unchanged: a compile-time binding is still judged
as one.

## Follow-up

The deref-adoption lane's workaround in
`src/evaluator/shared/suspension_analysis.yo` (a read-only clone snapshot in
place of the borrowed `for`, marked with this issue's path) can be reverted to
the borrowed `for` once this fix is on its base.

## Test

- `tests/borrow_spelling.test.yo`, "a borrowed for over a &mut param beside an
  Impl Fn param reads it". It covers the reproducer beside `&Impl(Fn(...))`
  and beside `&mut Impl(FnMut(...))` (whose state is kept across the loop's
  calls), the sibling-free control, `y := &m.*`, `match(&m.*, …)` and a generic
  `-> T` body. The companion test "a specialized body copies out of m.* and
  keeps the caller's value" covers the by-value `match(m.*, …)` copy and
  `bs_ident(m.*)`. On the develop-tip binary (142a2f972) the file's batch fails
  to compile with the E0926 above (0 of 39 tests ran). With the fix every test
  passes.
- `tests/impl_ref.test.yo`, "a specialized body dispatches (&b).m() and
  r.*.m() as written". On the develop-tip binary it fails at
  `(&b).name(): impl(&_RbBag, …) in a specialized body`, and it passes with the
  fix.
- `tests/internal/check_watch.test.yo`, "Phase 3b: a re-forced dependent reads
  its reference with .* as written". A body edit of `helper` re-forces `walk`.
  The same fixture fails a `check --watch-once` round on the develop-tip binary
  (`watch: …/lib.yo — FAILED`, the E0926 above), and the round is clean with
  the fix.
- `tests/comptime_fn_nested.test.yo`, "comptime_fn: a reference parameter read
  with .* folds". It covers both CTFE shapes above, each asserting `21`. It
  passes on the develop-tip binary (where the copied rewrite hid the gap),
  fails on the clone change alone (the batch does not compile: "Failed to
  create compile-time version of function"), and passes with the whole fix.
