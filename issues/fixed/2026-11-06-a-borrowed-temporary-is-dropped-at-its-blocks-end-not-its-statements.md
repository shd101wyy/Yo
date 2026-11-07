# A borrowed temporary is dropped at its block's end, not its statement's

**Severity:** S2: a temporary's `Drop` runs later than documented. `show(&make())`
keeps `make()`'s value alive, with its resources and its `Drop` side effects,
until the enclosing block ends. The values-by-default plan gives it Rust's
temporary lifetime: to the end of the enclosing statement.

> Found 2026-11-06 while writing VERDICTS-25's `Drop` holder test for N1e-2b
> PR 2b. Reproduced on develop `935c6ee69` with a plain struct, so the
> behavior is not specific to references or origins.

## Reproducer

```yo
{ assert } :: import("std/assert");
(mut(g_n) : i32) = i32(0);
Plain :: struct(n : i32);
impl(
  Plain,
  Drop(
    drop : (fn(self : &mut Self) -> unit)({
      g_n = (g_n + i32(1));
    })
  )
);
rd :: (fn(p : &Plain) -> i32)(p.n);
main :: (fn() -> unit)({
  assert(rd(&Plain(n : i32(3))) == i32(3), "read");
  assert(g_n == i32(1), "the temporary is dropped at the statement's end");
  ()
});
export(main);
```

The second assert failed. Wrapping the first statement in its own block
(`{ _a := rd(&Plain(n : i32(3))); };`) made it pass: the temporary was
dropped at the block's end. The same held for every lend shape: the exempt
`rd(mk())`, a `match(&mk(), …)` scrutinee, a method receiver `mk().m()`, and
a lend inside a binding's right-hand side (`x := rd(&mk())`). An exempt
CONSUMING match scrutinee (`match(mk(), …)` of a move-only value) already
dropped at the match: its arms own the scrutinee.

## Expected

`plans/VALUES_BY_DEFAULT.md` ("`&temp` is allowed"): "it borrows the
temporary, which lives to the end of the enclosing statement or `match`
(Rust's temporary lifetime)".

## Root cause

`attach_temp_variable_to_expr` registers an owning temporary in the NEAREST
begin-block frame, and `_schedule_scope_end_drops`
(`src/evaluator/exprs/begin.yo`) schedules every owning frame local's drop
onto the BLOCK's `deferred_drop_expressions` — emitted at the C block's end.
Nothing distinguished a temporary a statement creates only to lend it, so its
`___drop` ran with the block's scope-end flush (and on the block's escape
paths), after every later statement of the block. There is no lifetime
extension to preserve: a binding of a borrow of a temporary is already
rejected (`t : &make_name()`), so the borrow always ends with its statement.

## Fix

Landed 2026-11-06 (`fix/borrowed-temp-stmt-end-drop`). A temporary a
statement LENDS is now dropped right after that statement, on every
statement-loop emitter:

- The evaluator marks only the lent expression's SOURCE TOKEN
  (`note_lent_temporary`, `src/expr_info.yo`, keyed `module:row:column` in
  `g_lent_temp_tokens`, `g_borrowed_match_sites`' pattern). Two sites decide a
  lend: the marker-peel convergence `apply_call_site_borrow_markers`
  (`src/evaluator/calls/helper.yo`), which every call path crosses with the
  callee's parameter SLOT list — an argument whose slot is a `Reference`
  (shared or exclusive; the `param_is_ref` flags name only the `&mut` ones)
  is marked whatever its spelling, the marker `show(&make())`, the exempt
  `show(make())`, a `&self` receiver, before the marker scan's early return —
  and the non-consuming match scrutinee (`src/evaluator/exprs/match.yo`).
  The mark strips the borrow marker itself: the temp is minted at the inner
  expression's token. A token, not a name: a call argument is evaluated
  several times (candidate trials, the final pass) and every pass mints its
  own temp name, so a name-keyed record (the first design) held a trial's
  name and never the emitted tree's; the token is the one fact every pass
  shares, and the mark is idempotent across them.
- The temp KEEPS its block-scheduled scope-end drop, so every escape path
  INSIDE the statement still releases it (an unwind past a lent temporary
  drops it, as before). The statement loops correlate the marks with the
  drops the block actually scheduled right after each non-final statement
  (`_flush_stmt_lent_temp_drops`, `src/codegen/exprs/begin.yo`): each
  pending drop's target Variable (`_get_deferred_drop_target_variable`)
  whose mint token is marked and lies in the statement's span — at or after
  the statement's start token and, in the same module, before the next
  sibling's — is emitted there. The loops: the begin block's two forms, a
  function body (`src/codegen/functions/generation.yo`), a `match` case body
  (`src/codegen/exprs/match.yo`), a `cond` arm (`src/codegen/exprs/cond.yo`),
  a `while` body (`src/codegen/exprs/while_loop.yo`) and an `io.async` body
  (`src/codegen/async/state_machine.yo`, whose body-end flush now consults
  the emitted-once set). The emitted-once guard
  (`FunctionGenerationContext.emitted_deferred_drop_ids`) keeps the
  statement-end flush, the block-end flush and every exit path to ONE
  release. A FINAL statement keeps the block-end flush: nothing runs between
  it and the block's end, so the two are the same point.
- Not flushed early, by design: a temporary that is not the lent expression
  itself (`f(&g(h()))` marks `g(h())`; `h()`'s own temp keeps the block-end
  drop, as before), and a composite temporary whose FIELD takes the lend
  (`S(at : &mk())`: the struct's temp is minted at `S`'s token). Both drop
  later than Rust would, never earlier.
- Two soundness rules the first full sweep forced (three tests —
  `tests/dyn.test.yo`, `tests/for_read_walk.test.yo`,
  `tests/ref_enum.test.yo` — regressed to heap-use-after-free without them):
  a statement-end flush targets only a MINTED TEMPORARY, because a
  lowering's hidden named locals (`for_src0`, `for_guard0`) share the
  statement's token with its synthesized nodes, so token-span attribution
  would place their release inside a loop body whose iterations still read
  them; and the while body's own scope-end drop loop
  (`src/codegen/exprs/while_loop.yo`) now consults
  `emitted_deferred_drop_ids`, like begin.yo's scope-end pass and
  drop_dup.yo — a lent temp inside a loop body was otherwise released twice
  (statement end plus body scope end). The same double release was crashing
  three `tests/internal` analysis files through the embedded compiler.

Tests: `tests/local_borrows.test.yo` ("a borrowed temporary is dropped at its
statement's end": the marker, exempt, scrutinee, receiver, binding-RHS and
two-temps shapes; "a lent temporary is dropped when its statement unwinds
past it") and the rewritten temporary-holder test in
`tests/origins/reference_read_rule.test.yo` (VERDICTS-25 §2 item 3: dropped
at statement end as a temporary, at scope end when bound, on unwind too).
