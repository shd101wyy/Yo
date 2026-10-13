# A wrapper-pattern test lends its task to `io.await`, which takes the future by value

**Severity:** S3 — test-only: the batch for `tests/match_async_arms.test.yo` failed to compile on develop, so all 16 of its tests reported failure

Found 2026-10-13 by develop's battery (run 38329156294, job `test-wasm32_emscripten`).

## Symptom

```text
error[E0914]: `&task` lends a borrow, but parameter "fut" takes its argument by value: pass `task` (it moves, or is copied when it is `Copy`), or `task.clone()` to keep `task`.
yo: error: test: tests/match_async_arms.test.yo — 0 of 16 tests in this batch ran: the batch failed to compile
```

## Root cause

A merge skew between two PRs that were each green on their own. #1327, the wrapper patterns, added "a wrapper pattern Rc(p) with an await (decision 31)", which awaits with `io.await(&task, io)`. #1323, V3 async A1 (move-only futures), had already changed `io.await` to take its future by value, so a lend there is E0914. #1327's branch was cut before #1323 landed, and it was not re-tested after its rebase.

## Fix

The test awaits `io.await(task, io)`. This is the only `io.await(&…)` in `tests/`, `std/`, `src/`, `docs/` and `.github/`.
