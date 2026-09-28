# `tests/thread.test.yo` "concurrent directory iteration on three threads" fails on wasm

**Status: FIXED (2026-09-28).** Found from CI on PR #982: `test-wasm32_emscripten`
fails with `unexpected exception` / `Aborted()`. Develop's own battery has
failed the same way since #974 added the test.

## Root cause

The test's per-thread helper named its private directory
`yo_thread_dir_iter_${get_thread_id()}`. On wasm, `get_thread_id()` returns
0 on every thread (runtime_core's wasm arm), so all three threads used one
directory, and the second `create_dir` threw `EEXIST` into the test's
`assert(false)` handler. It was a test defect, not a runtime one.

## Fix

The helper takes the directory's index as an argument (a literal at each
spawn, so the spawn closures still capture nothing).
