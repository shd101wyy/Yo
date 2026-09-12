# Two `while` loops in one `io.async` body emit the same `while_loop_N` C labels

**Status:** FIXED 2026-09-11 (`fix/async-nested-while-labels`, stacked on #592).
**Found:** 2026-09-11, compiling `src/build_runner.yo` on branch `p1/imports-plumbing`
with the v0.2.30 seed (so the emitter is the seed's; the fix, when it lands,
takes effect one generation later — the bootstrap veil).
**Severity:** medium — a legal Yo shape (a nested loop inside an async
function) fails at the C compiler with no Yo-level diagnostic.

## Symptom

```
yo-p4.c:2735940:7: error: redefinition of label 'while_loop_2_continue'
yo-p4.c:2735328:7: note: previous definition is here
yo-p4.c:2735951:7: error: redefinition of label 'after_while_loop_2'
yo-p4.c:2735339:7: note: previous definition is here
```

## Shape

```rust
resolve_import_roots :: (fn(registry : BuildRegistry, project_dir : String, io : Io, exn : Exception) -> Impl(Future(unit, IoExn)))(
  io.async((e : IoExn) => {
    (ai : usize) = usize(0);
    while(ai < registry.artifacts.len(), {
      artifact := registry.artifacts(ai);
      (i : usize) = usize(0);
      while(i < artifact.imported_modules.len(), {
        imp := artifact.imported_modules(i);
        x := e.io.await(some_future(..., e.io, e.exn), e);   // await inside the inner loop
        // ...
        i = (i + usize(1));
      });
      ai = (ai + usize(1));
    });
  })
);
```

An OUTER `while` whose body contains an INNER `while` that awaits: the async
state-machine emitter (`src/codegen/async/`) numbers loop labels per loop
depth or per segment rather than per loop, so both loops' `while_loop_2_*`
labels land in one C function. A single loop with awaits is fine
(`execute_dag`), and so are two SIBLING loops without awaits in a plain fn.

## Workaround (applied)

Give the inner loop its own async function
(`_resolve_artifact_import_roots`) and `await` it from the outer loop — one
`while` per `io.async` body.

## Root cause and fix (2026-09-11)

The label collision was one symptom of two gaps in how an OUTER loop's
remaining body is carried past a suspension, both in
`src/codegen/async/state_machine.yo`. Minimizing produced three shapes; the
first already worked, the other two failed differently:

| shape | pre-fix |
| --- | --- |
| outer `while` whose body's FIRST await-bearing statement is the inner `while` | correct (the `outer_while_loop` attachment) |
| an await in the outer body BEFORE the inner loop | the inner loop ran one iteration and its post-await body vanished — silently wrong output |
| an await in the outer body AFTER the inner loop | `sm->var_N = ;` — a C compile error |

1. `_emit_while_continuation` chains the outer body's remaining statements
   past its additional await by INSERTING a `WhileLoopInfo` at the next await
   index — but when that await lives in a nested `while`, the nested loop had
   just registered ITS OWN entry at that index (it is emitted by
   `generate_remaining_expr_future`), and the insert overwrote it. The next
   state then treated the inner loop's await as the outer loop's.
   `_chain_while_remaining` now attaches the outer body's rest as the existing
   entry's `outer_while_loop` (the same resolution `_emit_cond_branch_remaining`
   already had for cond arms) and only inserts when the index is free.
2. `_emit_outer_while_continuation` emitted the outer body's statements after
   the inner loop as plain code, so an `x := io.await(...)` among them was
   rendered by the in-state-machine await generator as an empty operand. It
   now stores that await's future and parks the rest of the body on the next
   state through the same `_chain_while_remaining`, skipping its own
   continue/loop-back (the next state's continuation, keyed on the outer loop's
   origin index, emits them).

The original `while_loop_2_*` redefinition was this collision seen from the
other side: two loops' entries claiming one index. A single-level loop emits
byte-identical C before and after.

**Gate:** `tests/async_await.test.yo` — "nested while loops in one async body
with awaits before, inside and after the inner loop";
`issues/repros/nested-while-loops-in-an-async-body-redefine-c-labels.yo` is the
minimized shape (`pre;head-AA;…;end-BB;`).

## To do (as filed)

Minimize to `tests/async_await.test.yo` shape (nested `while`, inner await),
verify red on develop's gen-2 binary, then make the FSM while-emitter mint one
label pair per loop instance. Add the shape to the async-body notes in
`.github/instructions/debugging.instructions.md`.
