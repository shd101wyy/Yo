# `io.await` in branch positions: what works, what is rejected, where the two compilers disagree

**Measured 2026-08-09**, both compilers, after fixing the `if`-body case
(`issues/fixed/yo-self-init-segfaults-on-first-run.md`). Every row below was run,
not inferred — the repro harness is described at the bottom.

"TS" = the reference compiler (`src/`). "SELF" = the self-hosted binary built
from `yo-self/`. All rows are inside an `io.async((e) => { ... })` block; outside
one, `io.await` is a synchronous drive loop and none of this applies (which is
why `tests/fs/dir.test.yo` has used `cond(io.await(...) => ...)` at top level for
ages without trouble).

| shape                                           | TS                                      | SELF                          |
| ----------------------------------------------- | --------------------------------------- | ----------------------------- |
| `cond(c => { await f })` — branch VALUE         | ✅ works                                | ✅ works                      |
| `if(c, { await f })` — body                     | ✅ works _(fixed)_                      | ✅ works                      |
| `if(c, { await f }, { await g })` — both bodies | ✅ works _(fixed)_                      | ✅ works                      |
| `x := await f; if(x, ...)` — hoisted            | ✅ works                                | ✅ works                      |
| `cond(await f => ...)` — CONDITION              | ⛔ rejected _(was: invalid C)_          | ⛔ rejected                   |
| `if(await f, ...)` — CONDITION                  | ⛔ rejected _(was: **rc=0 + SIGSEGV**)_ | ⚠️ **works**                  |
| `match(m, .Some(x) => { await f })` — ARM       | ✅ works                                | ❌ **silently drops the arm** |
| `match(await f, ...)` — SCRUTINEE               | ❌ invalid C                            | ❌ invalid C                  |

Three of these need follow-up. None blocks the `if`/`init` fix, and none is a
regression from it — the last two rows were verified against a self-hosted
binary built _before_ that work.

## 1. `match` arm containing an await is silently dropped by SELF

**The worst class in the table: rc=0, no diagnostic, wrong behaviour.**

```rust
m := Option(i32).Some(i32(1));
match(m, .Some(x) => {
  v := e.io.await(num(e.io), e.io);
  println(`arm ${x} ${v}`);      // TS prints "arm 1 7". SELF prints nothing.
}, .None => ());
```

TS: `arm 1 7`. SELF: the arm body never runs; execution continues past the
`match` as if no branch matched. The identical `match` **without** the await
runs correctly under both, so the await is the trigger, not the pattern.

Pre-existing — reproduced on a self-hosted binary built before any of this
work. Nothing in the corpus covers it, which is why the full-corpus hollow
sweep is green: `tests/async_await.test.yo` had `cond`-with-await coverage but
no `match`-with-await coverage. Worth adding that coverage with the fix, since
a silent wrong-answer is exactly what the sweep exists to catch.

## 2. `match(await f, ...)` emits invalid C in BOTH compilers

```
error: expected expression
  sm->var_847275 = ;
```

Same root cause as the `cond` condition case: the scrutinee's code comes back
empty because the await was supposed to be split out, and nothing splits it.
Loud, so not dangerous — but it should be rejected with the same
"hoist it into a local" diagnostic the `cond` and `if` conditions now get.
The guard would go in `generateMatchWithAwait` alongside the existing
`awaitIsInCondPosition` check, keyed on args that are not `=>` pairs.

Nothing in the corpus uses this shape (`grep -rn --include='*.yo' 'match(.*\.await('`
over `std yo-self tests src/tests` returns nothing), so adding the rejection is
safe.

## 3. `if(await f, ...)`: TS rejects, SELF accepts

SELF compiles and runs this correctly. TS rejects it, because splitting an
await in condition position needs a state per condition and the reference
state machine does not model that — TS's `if` expands to a plain
`cond(c => ..., true => ...)` with the await left in the condition.

SELF evidently arrives at a shape where the await is already a statement. The
divergence is therefore in the `if` macro expansion, not in the state machine.

This is the safe direction of the two (the reference is stricter, and its old
behaviour here was a segfaulting binary), and it is invisible to every gate
because no corpus file uses the shape. But it does mean a program can compile
self-hosted and be rejected by the reference compiler. Unify by either
teaching TS the hoisting expansion SELF uses, or rejecting in both — deciding
which requires reading yo-self's `if` expansion against `src/`'s.

## Reproducing

Each row is a body spliced into a fixed harness and compiled by both binaries:

```rust
do_it :: (fn(io : Io, exn : Exception) -> Impl(Future(unit, IoExn)))(
  io.async((e) => {
    <BODY>
  })
);
main :: (fn(io : Io, exn : Exception) -> unit)({
  io.await(do_it(io, exn), IoExn(io : io, exn : exn));
  println(String.from("END"));
});
```

`END` alone in the output means the branch body was skipped — that is how row 7
was caught. A harness that only checks the exit code passes it.
