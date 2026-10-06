# Naming `JoinHandle(T)` inside a sync test body emits a call to an undeclared runtime function

**Severity:** S2 — a valid program that only names `JoinHandle(i32)` (here in a `Type.impls` query) fails at the C compiler, with no Yo diagnostic

**Status:** OPEN. Found 2026-10-06 while writing `tests/send_sync.test.yo`; reproduces on develop
`f946af074`.

## Symptom

`issues/repros/join-handle-named-in-a-sync-test-body.test.yo`:

```rust
test("jh", {
  comptime_assert(!Type.impls(JoinHandle(i32), Sync), "JoinHandle is not Sync");
});
```

`yo test` on it fails in clang:

```
error: call to undeclared function '__yo_join_handle_release_raw'; ISO C99 and later do not
support implicit function declarations [-Wimplicit-function-declaration]
  __yo_join_handle_release_raw(((void*)(__yo_v_self->__future)));
```

The same query with `Send` fails the same way. At module level (as in
`tests/thread_safety.test.yo`) it compiles.

## Root cause (partial)

Naming the type inside a function body instantiates `JoinHandle(i32)` and emits its `Dispose`
body, which calls `__yo_join_handle_release_raw`. That helper is defined only with the async
runtime (`src/codegen/async/runtime_core.yo`), which a program with no `io.async` does not emit.
The dispose body, or the runtime helper's declaration, must follow the same "is the async runtime
in use" decision.

## Workaround

Ask about `JoinHandle` at module level, as `tests/send_sync.test.yo` does.
