# The compiler's own build path drives blocking awaits inside async tasks — the strict-cleanliness CLI golden has been red since it was added

**Status: OPEN (fix landing with this issue); the golden `async-blocking-await-inside-task` was RED from birth.**
Found 2026-08-30 continuing the std audit handover: §2a's "strict-mode
regression" was misdiagnosed as fallout of the version_cache un-hollowing. It
is not — the regression predates and is independent of those fixes.

## The false alarm, cleared

The handover's diagnosis: un-hollowing `version_cache.yo` made formerly-dead
`io.async` bodies execute inside `run_build`'s task, tripping the C37 guard
under `YO_ASYNC_STRICT=1`. Measured against the actual binaries:

- The **released v0.2.20 seed** (develop at cut time, no version_cache fixes)
  aborts rc=134 on the golden's own tiny fixture — before any build output.
- A binary built at **#337 itself** (82e3c467d, where the golden was added),
  compiled by the v0.2.20 seed, aborts identically.
- The v0.2.19 seed does not abort — it predates the guard entirely (no guard
  string in the binary; the fixture runs rc=0 with no panic at all).

**Why #337's own verification said "clean"** (the retirement note on
issues/retired/compiler-build-runner-nests-event-loop.md): a compiled
program's runtime C comes from the COMPILING binary's embedded templates. The
#337-era smoke-test binary was compiled by the v0.2.19 seed, whose runtime
templates carry no guard — the binary could not fire the very guard its source
added. The first binary actually able to abort (v0.2.20) went red on the
golden immediately. `cli-diff-test.sh` is wired into no workflow, so nothing
in CI ever saw it.

## The real defects (all fixed here)

Backtrace at the abort (identical shape on every binary that has the guard):

```
__yo_user_main → run_build_cmd → poll_step → run_build SM resume
  → evaluate_build_file SM → mm_load_file (plain fn) → poll_step → GUARD
```

1. **Module loading did its file reads through the async `std/fs` `read`.**
   `mm_load_file` read the entry file and `_load_module_at_abs` read every
   demand-loaded import — each an `io.await` in a NON-io.async function, i.e.
   a blocking poll loop, run inside `run_build`'s task (C37/C42). Module
   loading is COMPTIME work: the evaluator calls the demand loader
   synchronously, so it can never be a future. Fix: `_read_file_sync` in
   module_manager — libc open/read/close, mirroring `_path_exists_sync`, with
   `IoError.from_errno` thrown through the same exn so error values match
   std/fs exactly. Comptime I/O no longer touches the event loop at all (also
   strictly better for the LSP). `g_loader_io` and `mm_eval_entry_exprs`'s io
   param went vestigial and were removed.

2. **The build-graph helpers blocked inside `compile_artifact`'s task**:
   `_git_version`, `_cache_collect_yo_files`, `_cache_read_file`,
   `_read_stamp`, `_write_stamp` — the retired issue's own site list. All are
   now `io.async` futures awaited properly by `compile_artifact`.

## The conversion recipe (why it looks like this)

Two language realities shaped the fix:

- **A local `Exception` handler + `unwind(value)` inside an `io.async` body
  LOSES the value and aborts the future** (probed: the caller's subsequent
  statements silently never run — awaiting an aborted future discards the
  caller's remaining continuation). So the plain-fn swallow handlers could not
  simply move inside async bodies.
- **Branch-nested awaits still drop continuations**
  (issues/async-await-in-nested-if-drops-continuation.md), so every await in
  the converted bodies is a top-level statement and every decision is data.

The pattern that satisfies both (established by `Command.output`'s stderr
drain): run the throwing operation as a **spawned task whose body carries its
own local swallow handler**, poll `is_finished()` + `await yield()`, then
`handle.await` — a task that unwound is `.None` at the handle. `_git_output_task`,
`_read_bytes_task`, `_read_dir_task`, `_write_string_task` are those bodies.

Semantic deltas, deliberate and reviewed:

- `_cache_collect_yo_files` is now a breadth-first worklist (was recursion);
  it visits the identical file set, and the per-directory sort keeps the
  stamp deterministic — its VALUE changes once (traversal order), which
  invalidates every inputs-sha256 cache exactly one time.
- `_write_stamp` now writes even an EMPTY stamp (cache disabled / stamping
  failed): truncating the previous stamp is the correct outcome in both cases
  (the next build must not cache-hit), and it keeps the write await
  branch-free.

## Verification

- `YO_ASYNC_STRICT=1 <new binary> build run` on the golden fixture: the
  compiler survives, the fixture program panics with the guard message, rc
  propagates — `scripts/cli-diff-test.sh --filter async-blocking-await-inside-task`
  goes PASS.
- The same battery of paths the retired issue listed (`check ./std`, `doc`,
  smoke build) re-verified green.

## Follow-ups this surfaces

- `ssize_t(0)` — constructing a `c_include`-declared TYPE through its module
  binding — fails def-eval and the failure is SWALLOWED, hollowing the whole
  function (bisected: `fcntl.open`/`__yo_errno` externs are fine; the
  constructor is the trigger; casting the RESULT, `i64(n)`, is fine). Same
  enforcement family as the arity row: def-eval failures inside function
  bodies must not be silent.
- **`unwind` inside a local handler in an `io.async` body must carry the
  FUTURE's payload type** — `unwind(())` (or any other type) fails def-eval
  with "Incompatible type for `unwind` argument: Expected (enclosing function
  return type): T" AND THE FAILURE IS SWALLOWED, hollowing the whole SM.
  Found by `YO_DEBUG_SWALLOW=1 check` after two blind iterations; the dummy
  payload value is discarded (the task aborts either way), only its TYPE is
  checked. Unit payloads (`Future(unit, …)`) unwind with `unwind(())` —
  that IS the matching type; the trap is declaring the task's payload as
  anything the awaited fn does not actually return (`_write_string_task`
  declared `usize` while the module-level `write_string` returns
  `Future(unit)` — the unify failure was swallowed too). Plain (non-async)
  functions are unaffected: their handlers' unwind payloads type-check
  against the fn's return type as written.
- Two more swallowed-shape casualties from this conversion, both hollowing a
  whole SM silently: (a) an `if(cond, { Result...Ok(()); }, {...Err...})`
  whose then-branch was made a single semicolon-terminated statement — the
  branch value became `unit`, the arms no longer unified, and the failure
  was swallowed (fix: a `cond`-tail with typed arms); (b) `_ := handle.await(...)`
  as a discard of an `Option(usize)` inside an async body — "Cannot unify
  unit and usize", swallowed (fix: a `match` over the Option). Every one of
  these was invisible to `yo check` and only visible in the emitted C's
  `__attribute__((error("failed to transpile")))` markers — grepping the
  emitted C for `failed to transpile` after every build is the working
  tripwire until the async-SM gate exists.
- `cli-diff-test.sh` has no CI wiring — the golden was red for two releases
  unnoticed. Wiring the corpus into a workflow is the durable fix.
- The aborted-future-await semantics (silent continuation discard) deserves
  its own issue and a compiler diagnostic — it turned five silent breakages
  into RC=0 no-ops this week (the hollow-SM family).
- `src/doc_command.yo` is wall-to-wall plain-fn `io.await`s reached from
  `_run_doc_step` inside `execute_node`'s task — a `doc` step in a build under
  strict mode still aborts. Same recipe applies (its module reads are already
  sync via this fix; the walk/exists/metadata/command awaits remain).
- The retirement note on issues/retired/compiler-build-runner-nests-event-loop.md
  is factually wrong (its clean verdict was structurally impossible); this
  file supersedes it as the record.
