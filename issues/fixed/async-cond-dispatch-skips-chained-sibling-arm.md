# Dispatch-mode cond: a sibling arm's SECOND await is neither awaited nor extracted when its continuation is chained

**Found**: 2026-08-28 (C33; `std/http/client.yo`'s `fetch_with` http arm crashed
with `TcpStream.write_string(self = NULL)` against a loopback server).
**Status**: FIXED in the C33 change — `src/codegen/async/state_machine.yo`.
Verified RED first with the repro below (rc=139), GREEN after.

## Symptom

```rust
cond(
  use_tls => { tls := e.io.await(TlsStream.connect(...), e); _wn := e.io.await(tls.write_string(`x`, e.io), e); ... },
  true => {
    addrs := e.io.await(lookup_host(`127.0.0.1`, e.io), e);          // depth 0
    c := e.io.await(TcpStream.connect(SocketAddr.new(addrs(0), port), e.io), e);  // depth 1
    _w := e.io.await(c.write_string(`hi`, e.io), e);                 // ← c is NULL → SIGSEGV
  }
)
```

`issues/repros/async-cond-dispatch-skips-chained-sibling-arm.yo` — an
`io.async` body with that cond, awaited from `main` against a bound listener
(no server needed: connect and write complete against the backlog). Before the
fix: rc=139. After: prints `h22 fd=<n>`.

Exactly `_fetch_once`'s shape since D6 PR-2 (#322) added the TLS arm — plain
`http://` fetch was broken from that PR until this fix; the CI test only
exercised https.

## Mechanism

Both arms await, and their futures have different C shapes, so the merged
suspension points run in **dispatch mode** (per-branch `case`s in the
readiness/registration and extraction switches —
issues/fixed/async-cond-shared-await-point-only-models-representative-branch.md).

Each arm's *additional* await (depth ≥ 1) is registered at the next await index
by `_chain_additional_remaining`. The first arm to get there claims the index's
`branches`; every later sibling arm is parked as a `chained_branches` layer —
and that record deliberately carried `await_target_variable_id : None`
(written for the nested-cond case, where the result belongs to the inner
cond's branch).

`_emit_await_suspension_dispatch` and `_emit_prev_await_result_extraction_dispatch`
iterated `cbd.branches` only. So for the TCP arm at depth 1:

- no `case 6:` in the readiness switch → its `connect` future was never
  registered (the `default:` jumped to the next state), and
- no `case 6:` in the extraction switch → `c` was never assigned.

`c` read as zero-initialised state → `write_string(self = NULL)`.

## Fix

- `_chain_additional_remaining` takes the depth's own binding
  (`_find_branch_await_target_variable_id` over the expr that carried the
  additional await — the `c` in `c := io.await(...)`); the nested-cond
  post-while caller still passes `.None`.
- `_find_branch_await_target_variable_id` accepts `=` re-assignment as well as
  `:=` (as `extract_target_variable_id` already did) — `raw_response =
  e.io.await(...)` in both of `_fetch_once`'s arms had no destination, so the
  response was awaited and dropped ("Invalid status line" on every fetch).
- `generate_remaining_expr_future` stores the future for `var = io.await(...)`
  as it already did for `var := io.await(...)`; the `=` form fell through to
  `// Warning: unhandled await pattern in remaining expressions`, so the arm's
  next await had a NULL slot and was SKIPPED (the http arm went from `write`
  straight to `close`, then dereferenced the never-produced response).
- New `_dispatch_branches(cbd, cond_field, idx)` unions the entry's
  `branches` with every `chained_branches` layer keyed on the same dispatch
  field (first record per code wins); both dispatch emitters switch over that
  list. A chained layer on a *different* field is refused with a
  `codegen_fatal` rather than mis-emitted — no such shape exists in std/tests.

Gate: the repro; `tests/http/http.test.yo`'s new loopback-server tests
(redirect chain, TooManyRedirects, max_redirects 0, ResponseTooLarge, Timeout)
all drive `fetch_with`'s two-arm cond against a sibling task.
