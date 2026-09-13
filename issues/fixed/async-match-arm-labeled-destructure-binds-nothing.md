# A labeled / curly destructuring pattern in an await-carrying `match` arm binds nothing — the body reads zeroed state-machine fields

**Status: OPEN (found 2026-09-13 during the `match` audit, `plans/MATCH_PATTERN_MATCHING.md` §2.1 row A3).**
Silent wrong answer. Reproduces on `develop` `1780b90cb` with the v0.2.31 seed
and with a compiler built from PR #661's branch (the PR does not touch this
emitter).

## Symptom

```rust
Shape :: enum(Circle(radius : i32), Rect(width : i32, height : i32));
// s = Shape.Rect(4, 5) at runtime
task := io.async((io : Io) => {
  result.* = match(
    s,
    .Rect({ width, height : h }) => {
      io.await(yield(io), io);
      (width * h)
    },
    .Circle(radius : r) => {
      io.await(yield(io), io);
      (r * r)
    }
  );
});
io.await(task, io);
println(`result=${result.*}`); // prints  result=0   — expected 20
```

`yo check` passes, the C compiles without a warning, and the program prints
`result=0`. The positional twin (`.Rect(width, h) => …`, `.Circle(r) => …`)
prints `result=20`. Outside `io.async` (no await in the arm) both spellings
are correct.

Reproducer: `issues/repros/async-match-arm-labeled-destructure-binds-nothing.yo`
(`yo compile --std-path ./std --optimize 2 <file> -o t && ./t`).

## Root cause

The async state machine has its OWN match-arm destructuring loop,
`_generate_match_with_await_impl` in `src/codegen/async/state_code_gen.yo`
(the "Destructuring: bind variant fields." block, ~line 3580). It iterates the
pattern's args positionally and binds **only bare atoms**:

```rust
dvar := match(pargs.get(di), .Some(d) => d, .None => match_expr);
if(ast_expr_is_atom(dvar), {           // labeled `(label : var)` is a ":" FnCall → skipped
  raw_name := ast_expr_token(dvar).value;
  … sm->var_N = <scrutinee>.data.<V>.<label at index di>;
});
```

A labeled parameter `height : h` is a two-arg `:` call, and the curly form
`{ width, height : h }` is ONE arg — the anonymous-struct call
`_(width : width, height : h)` — so the loop sees a single non-atom and emits
no assignment at all. The evaluator, meanwhile, did bind `width`/`h` in the
arm's env and allocated state-machine slots for them
(`_resolve_pattern_binding_sm_field` finds them), so the body compiles and
reads `sm->var_…` fields that were never written — zero-initialised SM memory.

Emitted C for the `.Rect` case (develop + v0.2.31 seed): the case opens,
records `sm->cond_branch_0 = 1;`, and goes straight to the `yield` call — no
`sm->var_… = sm->__capture.s.data.Rect.width;` lines. The positional control
emits exactly those two lines at the same spot.

The sync emitter (`_emit_destructure_binds`, `src/codegen/exprs/match.yo:948`)
handles labeled `label : var` and the lifted curly args correctly; the two
emitters have diverged since curly destructuring landed
(`tests/match_curly.test.yo` has no async case).

## Fix direction

Do not patch the positional loop a second time. `plans/MATCH_PATTERN_MATCHING.md`
P0 makes the async emitter reuse the sync emitter's destructure helper (labeled
+ curly + literal payloads) and adds `tests/match_async_arms.test.yo` with this
program as a red-first case; P2 replaces both loops with the shared
`pattern_emit.yo` helpers driven by the compiled `Pattern` IR.

## Verification (to fill in with the fix)

- `tests/match_async_arms.test.yo`: curly and labeled arms with an `await`
  in the arm must produce the same values as the positional spelling.


**FIXED 2026-09-13 (match P0):** the async state-machine emitter's arm destructuring was rewritten (`_aw_destructure_pattern`) — positional, labeled (`label : var`) and curly (`{a, b : c}`) all bind into their SM slot or a fresh C local, and literal payloads (which compare, via the arm's guard) bind nothing. Covered by tests/match_async_arms.test.yo.