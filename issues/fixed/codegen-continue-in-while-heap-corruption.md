# Codegen: `continue` in a `while` body can produce heap corruption

## Symptom

Intermittent `EXC_BREAKPOINT (SIGTRAP)` aborts inside the system
allocator (`_xzm_xzone_malloc_*` freelist paths) at unrelated, innocent
allocation sites (e.g. `ArrayList(u8).with_capacity` inside
`generate_variable_id`), long after the corrupting write. Crash victims
shift between runs and between binaries (different files of a check sweep
crash on different builds), exit code 133.

## Trigger (bisected 2026-06-07)

A `continue;` statement inside a `while(cond, { ... })` body, where the
loop body allocates Rc-managed values per iteration. Observed in
`yo-self/evaluator/calls/function.yo`'s FuncVal-arm argument loop:

```rust
while(ai < n_a, {
  arg_expr := match(args.get(ai), .Some(a) => a, .None => make_err_expr());
  if(quoted, {
    q_info := new_expr_info(env, t_expr_t());
    q_info.value = ...ExprVal(box(arg_expr.clone()));
    _push_q := evaled_arg_infos.push(q_info);
    ai = (ai + usize(1));
    continue;              // <-- THE TRIGGER
  });
  evaled_arg := evaluate_expression_raw(arg_expr, env, ctx, exn);
  ...
});
```

Restructuring the same logic as if/else (no `continue`) eliminates all
crashes — 13/13 repeated runs green across the four flakiest files
(tests/imm_threading.test.yo, std/sys/bufio/buf_writer.yo,
tests/encoding/json.test.yo, std/string/string.yo), where the `continue`
version crashed ~50% of runs. The committed yo-self (no `continue` in
this loop) was stable; adding only this loop's `continue` made it flaky.

## Root cause hypothesis

`continue` jumps to the loop-continuation point without running the
iteration tail. If the iteration's Rc cleanup (releases of per-iteration
temps like `arg_expr` clones, or scope-end drops) is emitted in the
skipped tail — or conversely runs TWICE via both the continue path and
the scope exit — a refcount goes off by one, and the double-free/UAF
corrupts the allocator freelist. The bisect strongly suggests the
`continue` cleanup path in `src/codegen/exprs/while.ts` (or the begin-
block temp-drop emission it interacts with) is wrong for bodies with
Rc-owning locals declared before the `continue`.

## Repro plan (TODO)

Extract a minimal `src/tests/fixme.yo`: while loop allocating an
Rc value (String/ArrayList) per iteration with a conditional
`continue` before further allocations, run many iterations, compile and
run — expect allocator abort / ASan double-free. Then fix the C emitter
and add the case to `tests/`.

## Workaround applied

`yo-self/evaluator/calls/function.yo` uses if/else instead of `continue`
(comment at the site points here).

## UPDATE (same day): second, larger corruption source found — unquote splice co-ownership

The `continue` removal fixed one cluster (imm_threading/buf_writer 13/13),
but flakiness persisted (std/regex/flags ~40%). Feature-bisect inside the
macro path (macros hard-disabled → 8/8 stable) localized it; the fix:

`yo-self/evaluator/builtins/quote.yo` unquote splice did
`.ExprVal(eb) => eb.*` — embedding the env-bound ExprVal's AST into the
expansion WITHOUT cloning. Expansion and bound value then co-owned interior
nodes; both dropping → double-free → intermittent allocator SIGTRAP at
unrelated sites. `eb.*.clone()` at both splice sites (regular unquote +
unquote_splicing list elements) → 10/10 + 21/21 green across all
previously-flaky files.

NOTE for the codegen investigation: whether plain `Box.* ` deref-copy of a
recursive enum RETAINS interior Rc children is the underlying question for
BOTH bugs in this file — `eb.*` compiled to a copy that shared children
without retaining. If deref-copy is supposed to retain, this is a C-emitter
bug reproducible from that shape; if it is shallow-by-design, every
`box(x.*)`-style rewrap in yo-self is suspect.

## RESOLVED (2026-06-11): no longer reproducible post-slice-rework

Re-tested after the slice rework (String/str representation overhaul,
`feat/slice-rework`):

1. **C-level inspection** of five variants of the bisected shapes
   (continue in while with Rc locals; continue inside if-in-match-arm;
   object locals with Rc field writes before continue; match-extracted
   Option payloads live at the continue point; Box deref-copy + rebuild)
   all show **balanced dup/drop emission** — the continue path emits the
   per-scope drops (including the Option temp deferred to the iteration
   tail) exactly once before the jump. The only wart is a dead duplicate
   drop emitted after `continue;` (unreachable, harmless).
2. **Behavioral re-test on the original protocol**: the `continue` form
   was restored in `yo-self/evaluator/calls/function.yo`'s FuncVal arg
   loop and the four flakiest files re-checked 13 rounds each
   (tests/imm_threading, std/sys/bufio/buf_writer, tests/encoding/json,
   std/string/string): **0 crashes / 52 runs** (originally ~50%).

The `continue` form is now kept in function.yo (it matches the TS
original). A runtime regression test for the shape lives in
`tests/continue_rc_cleanup.test.yo`. The deref-copy retain question is
answered: `Box.*` into a local emits `___dup` and drops exactly once.
