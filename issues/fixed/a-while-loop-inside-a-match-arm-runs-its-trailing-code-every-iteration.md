# A `while` with an await, inside a `match` arm, replayed the code AFTER it on every iteration

**Found**: 2026-09-14, root-causing #556. **Fixed**: same day, in
`src/codegen/async/state_code_gen.yo`. **Not a regression** — the v0.2.32 seed
reproduces it, so this has been live for as long as #556 has been failing.

## THIS IS THE ROOT CAUSE OF #556

`issues/a-bodyless-http-response-is-not-read-until-the-deadline.md` spent days
in the HTTP client, then kqueue, then io_uring. It is in none of them.

## The defect

A `match` arm containing a `while` whose body awaits, followed by any statement:

```rust
match(c, .Skip => { n = i64(-1); }, .Spin => {
  while(runtime(n < i64(3)), { e.io.await(yield(e.io), e.io); n = (n + i64(1)); });
  trail = (trail + i64(1));      // <- must run ONCE, after the loop
});
```

`trail` ended at **3**, not 1. A `println` in that position printed `n=0`,
`n=1`, `n=2` — the trailing statement was emitted INSIDE the loop body, right
after the await.

The same program with `cond` instead of `match` was always correct. That one
keyword is the whole difference, and it is what located the bug:

| spelling | trailing statement |
| --- | --- |
| `cond` branch | once, after the loop ✓ |
| `match` arm | once per iteration ✗ |

## Cause

`generate_cond_with_await` checks whether the branch's await sits inside a
while (`has_while`) and, if so, diverts the branch's `remaining` statements into
`cond_branch_post_while_exprs` — a slot that exists precisely so they run when
the loop EXITS. `_emit_match_case_await_or_value` passed `emission.remaining`
straight through as the arm's remaining code, with no such check, so those
statements became part of the loop body.

The machinery was all present; only the match path was not wired to it. The fix
mirrors the cond path's split.

## Why it produced #556's symptom exactly

`std/http/client.yo`'s `_fetch_deadline` is that shape — the race loop is in the
`.Some(limit)` arm of a match on `opts.timeout`, and the statement after it is:

```rust
cond(
  h.is_finished() => { ...deliver the response... },
  true            => { h.abort(); e.exn.throw(dyn(HttpError.Timeout)); }
);
```

Inside the loop, that `cond` ran on the FIRST turn. The exchange had barely
started, so `h.is_finished()` was false, so the `true =>` arm aborted it and
threw `HttpError.Timeout` — on an exchange that completes in about a
millisecond. Instrumented before the fix:

```
[srv] TASK ENTERED
[srv] about to accept          <- the server parks, correctly
[204] server spawned, issuing request one
[flw] FOLLOW TASK ENTERED      <- the exchange DOES start
[dl] spin begins
[dl] spin ended after 0 turns h_fin=false dh_fin=false
unexpected exception: HTTP request timed out
```

That accounts for every open question in the other document:

- **always `Timeout`, never the real error** — the fallback arm is reached
  unconditionally on turn one; it can only report its own impatience.
- **the server sits in `accept`** — the client aborts before connecting.
- **identical on kqueue and io_uring** — neither is involved.
- **"the parent await never resumes"** — it was aborted, not stuck.
- **platform roulette** — the abort is deterministic; only how far the exchange
  gets before it is not, so the trace truncates in different places.

## A correction to my own first reading

I first reported this as "emits no loop at all", from the emitted C declaring
`while_loop_0_active` and never using it. That was wrong. The loop runs; the
unused field is a separate cosmetic artefact. The evidence that settled it was
the trailing `println` printing three times — behaviour, not inspection.

## Verification

- `tests/async_while_in_match_arm.test.yo` — three tests, asserting the match
  arm, the `cond` spelling, and the untouched sibling arm. **Fails on the
  v0.2.32 seed on the match case only**, with the cond case passing: the
  differential is the point.
- `tests/http/http.test.yo`: **51/51**, including the 204 and HEAD tests that
  had been failing.
- Reproducer: `issues/repros/while-in-match-arm-trailing-code-runs-every-iteration.yo`.

## It reproduces locally, contrary to the record

The other document says 27 local runs were clean. On a current build
`tests/http/http.test.yo` failed on the FIRST run, and the single test in
isolation failed deterministically. Do not re-spend an afternoon proving it does
not reproduce.
