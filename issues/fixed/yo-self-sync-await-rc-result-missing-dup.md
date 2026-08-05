# yo-self: a synchronous `io.await` of an RC result skipped the `___dup` → over-release (FIXED 2026-08-05)

**Found 2026-08-05.** This was the Linux-only tier-1 gate failure:
`tests/async_await.test.yo` reported **115/116 on Linux and 116/116 on macOS** under the
self-hosted compiler.

The failing test was identified from the CI artifact, not guessed —
`gh run download 31011003610 -n bootstrap-self-test-logs`, then
`ci_async_await.log:186`:

```
  ✗ "Test await future multiple times returns same result"
```

(115 `✓`, that one `✗`.) **Note for future sessions: the tier-1 battery's per-file logs
are uploaded as the `bootstrap-self-test-logs` artifact and can be downloaded with
`gh run download`.** That is far quicker than reading the job log.

## Minimal reproducer

The `Box(i32)` half of `tests/async_await.test.yo:1660`:

```rust
{ assert } :: import("std/assert");
main :: (fn(io : Io) -> unit)({
  task := io.async((io : Io) => {
    return(Box(i32)(12));
  });
  r1 := io.await(task, io);
  r2 := io.await(task, io);
  r3 := io.await(task, io);
  assert(r1.* == 12, "first");
  assert(r2.* == 12, "second");
  assert(r3.* == 12, "third");
});
export(main);
```

| compiler             | exit                                           |
| -------------------- | ---------------------------------------------- |
| TS                   | 0                                              |
| self-hosted (before) | **133 — SIGTRAP, macOS heap-corruption abort** |
| self-hosted (after)  | 0                                              |

So it reproduces on macOS too, as a hard abort — the _test file_ passed on macOS only
because the surrounding allocation pattern happened to tolerate the corruption. On glibc
the over-release lands in the tcache `next` pointer, which is why Linux failed the test.

## Root cause

`yo-self/codegen/exprs/await.yo` (sync-await result extraction) mirrors
`src/codegen/exprs/await.ts:248-285` faithfully, including its two-armed shape:

```rust
match(
  get_dup_function_for_type(result_type, context),
  .Some(dup_fn) => …` = ${dup_fn}(${sync_future_var}->result);`,
  .None        => …` = ${sync_future_var}->result;`          // bare copy
);
```

The divergence is _which arm runs_. TS's `getDupFunctionForType` essentially always
succeeds, because `addRcFunctionsToStructType`
(`src/evaluator/types/utils.ts`) registers a `___dup` **method** for every RC type — TS's
`else` is effectively dead. yo-self synthesizes no such methods at all (`grep -rn
"add_rc_function" yo-self/` finds nothing; `drop_dup.yo` documents it), so
`get_dup_function_for_type` **always** returns `.None` and the bare copy is the _only_
path.

A bare copy hands out an additional owner with no increment, while the scope-end pass still
emits one decrement per binding. Awaiting one RC-result future three times therefore did
0 increments and 3 decrements on a `ref_count = 1` object.

## Fix

Use the inline dup generator that every other yo-self dup site already uses —
`generate_dup_code_for_value` from `codegen/exprs/drop_dup.yo` — in the `.None` arm of both
sync-await result paths (effectful and non-effectful). yo-self's RC strategy is inline
`__yo_incr_rc` / per-field descent rather than synthesized `___dup` methods, so this is the
faithful choice _for its architecture_; porting `addRcFunctionsToStructType` instead would
be a far larger change and would also re-enable drop sites that are currently, deliberately,
absent (see the ordering hazard below).

Emitted C after the fix — one increment per await:

```c
_file____tmp__temp_5157 = ((__yo_t1*)__yo_incr_rc((void*)(__sync_future__file____tmp__temp_5157->result)));
```

3 awaits → 3 increments, matching the 3 scope-end decrements.

## ORDERING HAZARD — read before fixing the adjacent gaps

The same always-`.None` root also silences:

- the SM dispose drop of `sm->result` (`yo-self/codegen/exprs/async.yo`, emits
  `/* Warning: No ___drop function found for result type … */`),
- the in-SM await dup (`yo-self/codegen/async/state_machine.yo`),
- `JoinHandle.await` / `Option(T)` payload dup (`yo-self/codegen/exprs/await.yo`).

Today the missing dispose-drop **masks** the missing dup into a mere leak whenever a future
is awaited exactly once (1 implicit owner, 1 decrement). **Restoring any of those drops
without this dup fix in place converts a balanced single-await into an over-release.** This
fix is the prerequisite; the remaining sites should be fixed next, and together.

## Verification

- repro: 133 → **0**
- `tests/async_await.test.yo` under the self-hosted binary: **116/116** (was 116/116 on
  macOS, 115/116 on Linux — the Linux arm is what this fixes)
- `tests/arc.test.yo` 15/15, `tests/cycle_collector.test.yo` 16/16
- `check ./yo-self` 237/237
- battery 20/20 hollow=0, corpus PASS 155 DIFF 0, `check ./std` 153/153, FIXPOINT_HOLDS

## Credit where the audit was wrong

A five-way audit of the async port ranked this finding **4th**, with the note "cannot
produce a platform-dependent single-test failure", and ranked a systematic-leak theory
first. The leak theory was refutable outright: the failing gate runs the _self-hosted_
runner, and `yo-self/main.yo:995` sets `sanitize = ""` — no sanitizer, so leaks cannot fail
a test there. Checking which runner produces the number is what turned a plausible story
into the actual one.
