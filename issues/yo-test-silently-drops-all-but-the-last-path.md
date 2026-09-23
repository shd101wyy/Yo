# `yo test` silently drops every path argument but the last

**Status: OPEN** (found 2026-09-23 while gating `plans/SAFE_MODE.md` §14 R1).

## Symptom

```
yo test ./tests/http ./tests/encoding/html.test.yo --parallel 1
```

This ran only `tests/encoding/html.test.yo` (17 tests) and exited 0.
`./tests/http` (77 tests across 4 files) was not run, and nothing said so.
Running `yo test ./tests/http` separately ran all 77.

## Why it matters

The usage line documents a single path (`yo test [path] [options]`), but a
second path is neither rejected nor honored. A gate that lists several paths
reports green while skipping all but one of them. This is the same shape as
the "count the files that ran" trap in the testing instructions, but with no
failure to hint at it.

## Expected

Either accept several paths (run the union), or reject the extra argument
with an error naming it. Silently overwriting is the one wrong answer.
