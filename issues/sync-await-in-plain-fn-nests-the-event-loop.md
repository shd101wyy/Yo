# `io.await` in a plain (non-`io.async`) function is a nested blocking event loop — called from inside a task it deadlocks

**Found**: 2026-08-28, while adding loopback-server tests for C33
(`std/http/client.yo`). **Status**: OPEN (compiler/runtime diagnostic wanted);
the two in-tree instances are FIXED in the C33 change.

## Symptom

`fetch_with` against an HTTP server running as a *sibling task on the same
event loop* either SIGSEGVs (`TcpStream.write_string(self = NULL)`) or hangs
forever, depending on timing. Against a remote server it works, which is why
`tests/http/http.test.yo` (https://example.com only) never saw it. Plain
`http://` fetch had this shape since D6 PR-2 (#322) added the TLS arm, and
`_read_http_response` had the underlying hazard since the module was written.

## Mechanism (measured — `sample` of the hung process, `--debug-async-await`)

```
__yo_user_main                              main: io.await(connect) — SYNC await, blocking poll loop
  __yo_async_poll_step
    __yo_async_run_ready_tasks
      <server task>_resume                  accept completed → task runs
        _read_request(s, e)                 a PLAIN fn whose body does e.io.await(stream.read(...))
          __yo_async_poll_step              ← nested blocking loop, waiting for bytes that only
            ...                               main — frozen underneath on this stack — can send
```

An `io.await` outside an `io.async` body is compiled by
`src/codegen/exprs/await.yo` ("Synchronous await (io.await outside state
machine)") as `while (state != -1) __yo_async_poll_step();`. That is right for
`main`/test bodies (depth 0). But the same plain function can be called *from a
task*, and then the loop runs **inside** `__yo_async_run_ready_tasks`: every
task below it on the C stack is frozen until the awaited I/O completes. If the
I/O depends on one of those frozen tasks, the program deadlocks; if the nested
loop resumes a state machine whose frame is mid-step further down the stack,
memory is corrupted (the NULL `stream` in `fetch_with`'s http arm).

`JoinHandle.await`, and `std/async`'s `join_all`/`race`/`any`/`timeout`, poll
the loop the same way (`generate_join_handle_await`, `__yo_async_poll_step`),
so they carry the same hazard when called from inside a task — the
`timeout(h, limit, e.io)` shape the C33 handover notes proposed would have been
one.

## Reproducer

`issues/repros/sync-await-in-plain-fn-deadlock.yo` — a spawned loopback
server whose accept path calls a plain helper with an `e.io.await(read)`,
while `main` connects and writes from a synchronous await. Hangs (rc=124 under
`timeout 10`) roughly every run once `connect` has to wait for kqueue; passes
when `connect` completes synchronously (so it is timing-dependent — run it a
few times).

Compile with `yo compile <repro> --release -o r && timeout 10 ./r`.

## What was fixed in tree (C33 change)

- `std/http/client.yo`: `_read_http_response` is now an `io.async` future
  (`-> Impl(Future(String, IoExn))`) awaited by `_fetch_once` — a real
  suspension point, so a fetch against a sibling task's server works and a
  slow read no longer freezes every other task.
- `fetch_with`'s deadline is a race driven by awaiting `yield` between
  `is_finished()` checks on the request task and a spawned `sleep`, not by the
  blocking `timeout` combinator.
- The test helper `_read_request` is an `io.async` future.

A sweep found no other plain function in `std/` that awaits
(`_read_http_response` was the only one).

## What remains open — the diagnostic

The compiler cannot know statically whether a plain awaiting function will be
reached from a task. The runtime can: `__yo_async_run_ready_tasks` knows when
it is executing a task's resume function. Proposal:

- keep a `__yo_async_task_depth` counter around each resume call in
  `__yo_async_run_ready_tasks`;
- in `__yo_async_poll_step`, when `depth > 0`, fail loudly:
  `panic: io.await / JoinHandle.await / std/async combinator reached from
  inside an async task — this nests the event loop and can deadlock; make the
  function io.async and await it`.

This converts a silent, timing-dependent deadlock into a deterministic error at
the first offending site. It is a behaviour change (anything that "works by
luck" today, like a fetch against a remote server through a blocking reader,
would panic), so it should land as its own PR with the full suite as the
measurement of how many sites it fires on. Not done in the C33 change.
