# `io.await` in branch positions: what works, what is rejected

**Measured 2026-08-09**, both compilers. Every row below was run, not inferred.

"TS" = the reference compiler (`src/`). "SELF" = the self-hosted binary built
from `yo-self/`. All rows are inside an `io.async((e) => { ... })` block; outside
one, `io.await` is a synchronous drive loop and none of this applies (which is
why `tests/fs/dir.test.yo` has used `cond(io.await(...) => ...)` at top level for
ages without trouble).

| shape                                                 | supported                       |
| ----------------------------------------------------- | ------------------------------- |
| `cond(c => { await f })` — branch VALUE               | ✅ both                         |
| `if(c, { await f })` / `if`+`else` bodies             | ✅ both                         |
| `x := await f; if(x, ...)` — hoisted                  | ✅ both                         |
| `if(await f, ...)` — CONDITION                        | ✅ both                         |
| `cond(await f => ...)` — FIRST condition              | ✅ both                         |
| `match(await f, ...)` — SCRUTINEE                     | ✅ both                         |
| `while(await f, ...)` — CONDITION                     | ✅ both                         |
| `while(c, { ...await f... }, body)` — STEP            | ✅ both                         |
| `if(!(await f), ...)` — await NESTED in a condition   | ⛔ rejected, both               |
| `cond(c1 => .., await f => .., ..)` — LATER condition | ⛔ rejected, both               |
| `match(m, .Some(x) => { await f })` — ARM             | ⚠️ TS works, SELF drops the arm |

The two rejections are deliberate and carry a diagnostic naming the fix:

- **Nested** — the await must BE the condition. Substituting the extracted
  result into a larger expression asks codegen for helper specialisations the
  collection pass never saw, so the C calls undeclared functions. A general
  limit on nested awaits: plain `b := !(io.await(f, io))` fails identically.
- **Later `cond` branch** — `cond` is lazy, so hoisting would await even when an
  earlier branch matches. That is a change of meaning, not just of timing.

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

## 3. Two yo-self-only gaps found while testing this

Neither is a regression from the await-position work; both reproduce with **no
await at all**, and the tests in `tests/async_await.test.yo` are shaped around
them rather than depending on them.

- **`return(expr)` as a closure's FINAL expression** emits
  `int32_t __yo_scope_ret = return X;` — invalid C. Use a plain trailing
  expression instead.
- **An `io.async` closure capturing a mutable local, re-created every
  iteration**, omits the capture `___dup` that TS emits, so the captured Box is
  freed under the loop (rc=139). This is why the while-condition tests use a
  top-level `future_lt` helper rather than an inline closure.

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
