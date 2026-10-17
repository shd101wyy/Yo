# A closure parameter captured by an inner closure is E0901 when the argument closure is move-only

**Severity:** S2 — `spawn_blocking` (std/thread) rejected every move-only closure, so `tests/spawn_blocking.test.yo` failed to compile on develop (5 tests; the TSan and forced-epoll jobs too).

**Found:** 2026-10-15, develop battery run 38604999635 at `be5855a4a`. It was found independently on `feat/vbd-v3-async-a5` (#1379), which filed it as an open doc under this name.
**Status:** FIXED 2026-10-15.

## Symptom

```text
error[E0901]: use of moved value: the closure captures `cb`, whose type `Impl(Fn() -> T : (Send + Acyclic) + Send)` is move-only (it is neither `Copy` nor `Clone`), so the capture moves it, and `cb` cannot be moved: it is borrowed (a by-value parameter, a `match`/`for` binding, a `&mut` borrow or a module-level binding). Take it `sink(...)` to own it.
note: raised here, inside the standard library
    --> std/thread.yo:421:43
```

`spawn_blocking` takes `sink(cb) : Impl(Fn() -> T, Send)`. Its
`Thread(unit).spawn((tio : Io) => { … cb() … })` relay captures `cb`. The
parameter is already `sink`, yet the message tells the user to write `sink`.

Minimal shapes. Each fails when the argument closure is move-only, here
because it captures an `AtomicI32`:

```yo
_ss_run_on_thread :: (fn(generic(T : Type), sink(cb) : Impl(Fn() -> T, Send), where(T <: (Send, Acyclic))) -> T)({
  worker := Thread(T).spawn((tio : Io) => cb());
  worker.join()
});
_ss_take :: (fn(generic(U : Type), sink(f) : Impl(Fn() -> U)) -> U)(f());
_ss_relay :: (fn(generic(T : Type), sink(cb) : Impl(Fn() -> T)) -> T)(_ss_take(() => cb()));
```

The same functions without `generic(T)`, or with a `cb` whose type does not
mention `T`, were accepted. So was binding the inner closure to a local
instead of passing it to a call.

## Root cause

- #1366 (decision 36) made a closure over an `AtomicI32` move-only. Capturing
  `cb` now moves it (`move_captured_explicit_copy_variable`,
  `src/evaluator/utils.yo`). Before #1366 the capture copied it, so this path
  was never reached.
- Inside a specialized body, a closure parameter is a NON-owning callable
  shadow. The move therefore consumes the OWNING binding beside it, found by
  `_owning_param_binding_for_capture_move`
  (`issues/fixed/a-move-only-value-cannot-be-moved-into-thread-spawn.md`).
- When `cb`'s type mentions the function's type parameter, the call goes
  through the generic call-time binder (`_evaluate_funcval_runtime_call`,
  `src/evaluator/calls/function.yo`), which binds the parameter at the
  ARGUMENT's type. A closure literal's argument type is a plain `fn() -> i32`.
- `bind_parameter` (`src/env.yo`) keeps the declared `sink` flag only when
  the bound type is not bitwise-copyable (`is_owning && !type_is_bitwise_copy(bind_ty)`).
  A `fn(...)` type is bitwise-copyable, so the `sink` parameter was bound
  non-owning, and the owner lookup found no owner at all.
- Traced with a tree build (`[capbind fv] cb … own=true bind_ty=fn() -> i32`,
  then at the capture `#0 … own=false ty=fn() -> i32` and the shadow
  `#1 … own=false ty=Impl(Fn() -> T)`). When `cb`'s type does not mention
  `T`, the binding takes the declared `Impl(Fn(...))` type and stays owning,
  which is why only the generic shapes failed.

## Fix

- The binding is caller-owned at run time, and the caller and the callee
  agree on that: the caller does not transfer the argument
  (`consume_argument_for_parameter` sees the same bitwise type), and the callee
  does not release it. Only the body's closure-parameter shadow, typed
  `Impl(Fn() -> T)` and resolved to the move-only capture record, asked for a
  move.
- So a capture of such a parameter takes its own references (the `___dup`
  arm of `generate_captured_variable_dup_expressions`,
  `src/evaluator/utils/closure.yo`). That is the arm this capture took before
  #1366. `capture_of_caller_owned_sink_param` (`src/evaluator/utils.yo`)
  recognizes the shape: a non-owning closure-parameter shadow, no owning
  binding beside it, and a same-named parameter that is declared owned
  (`is_imm_borrow` false) but non-owning at a bitwise-copyable type.
- A closure that is move-only because it holds a `Dispose` value still moves,
  and is still E0901 in this shape. A copy of it would dispose twice. The
  binder's typing is the real defect:
  `issues/fixed/2026-10-15-the-generic-call-time-binder-binds-a-sink-closure-argument-at-a-bitwise-fn-type.md`
  (fixed 2026-10-17, which removed `capture_of_caller_owned_sink_param`).
- The first attempt was rejected by its own Tier 1 ASan run (heap-use-after-free
  in `tests/spawn_blocking.test.yo` and the new `send_sync` test). It made the
  owner lookup accept that binding, so the capture moved it. The inner
  closure then released references the caller also released.

## Verification

- `tests/spawn_blocking.test.yo` (5 tests) fails to compile before the fix and
  passes after.
- `tests/send_sync.test.yo` "a generic function's move-only closure parameter
  moves into a closure it passes on" covers both shapes above. It is E0901
  before the fix and passes after, under ASan too (Apple clang, macOS arm64).
