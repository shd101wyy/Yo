# Two `while` loops in one `io.async` body emit the same `while_loop_N` C labels

**Status:** OPEN
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

## To do

Minimize to `tests/async_await.test.yo` shape (nested `while`, inner await),
verify red on develop's gen-2 binary, then make the FSM while-emitter mint one
label pair per loop instance. Add the shape to the async-body notes in
`.github/instructions/debugging.instructions.md`.
