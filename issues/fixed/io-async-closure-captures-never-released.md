# An `io.async` closure never released its captured values — every async call leaked its captures

**Status: FIXED 2026-09-12** (`src/codegen/exprs/async.yo`: both dispose emitters and the
sync-future capture install). Found while pinning
`issues/fixed/async-match-arm-borrowed-payload-released-twice.md` with a `Dispose`
counter: a handle passed to an `io.async` function was never disposed, in ANY shape.

## Symptom

```rust
(g_d : i32) = i32(0);
H :: ref(struct(tag : i32));
impl(H, Dispose(dispose : (fn(self : Self) -> unit)({ g_d = (g_d + i32(1)); })));
s_h :: (fn(h : H, io : Io) -> Impl(Future(i32, IoExn)))(io.async((e : IoExn) => h.tag));
a_h :: (fn(h : H, io : Io) -> Impl(Future(i32, IoExn)))(io.async((e : IoExn) => {
  k := e.io.await(tick(e.io), e);
  h.tag + k
}));
// after awaiting either: g_d is still 0 — the H is never disposed.
```

Measured on the compiler's own emission: 116 state-machine dispose functions, none
dropping a capture. Every `url : String`, buffer, socket or handle a std/src async
function captures leaked for the process's life. Short-lived CLI runs never noticed;
CI runs with `detect_leaks=0`.

## Root cause

The call site DOES take a reference for the future: the closure emitter builds the
capture struct with the closure's deferred dups applied (`__capture_<fid>_N =
(cap){ .h = __yo_incr_rc(h) }`, `exprs/closures.yo`), and the state-machine
constructor receives it. But:

- **state machine** (`generate_async_block_state_dispose_function`): the capture drop
  went through `get_drop_function_for_type`, which never returns a synthesized
  `___drop`; the inline fallback `_emit_inline_capture_field_drops` → `_rc_field_drop_line`
  emitted a line only for pointer-shaped fields and NOTHING for Option/String/struct
  shaped ones — and in the measured emission even pointer captures went unreleased
  because the fallback never ran for the sync half (below).
- **sync future** (`generate_io_async_sync_call`): ignored the dup'd capture temp and
  installed a fresh borrowed re-copy of the fields (`->__capture = (cap){ .h = h }`),
  orphaning the dup'd temp; its dispose deliberately dropped nothing ("the capture is
  borrowed"). `issues/async-future-result-never-dropped.md` recorded this half as
  deferred "until the dup/drop pair lands together" — but the dup side was already
  landing (the closure emitter's), which is why the leak was exactly +1 per capture.

## Fix

- The sync future installs the closure's dup'd capture temp (`__capture_<fid>_N`) as
  its `__capture` — the reference it owns — and its dispose drops every RC-bearing
  capture field through `generate_drop_code_for_value` (side lines captured into the
  declarations buffer the way the result drop already is). The label-literal re-copy
  remains only as the fallback for a closure value that is not a capture temp.
- The state-machine dispose's inline fallback uses `generate_drop_code_for_value` for
  the fields `_rc_field_drop_line` has no line for, so Option/String/struct-shaped
  captures are released too. Captures are dropped in every state: the future owns them
  for its whole life and nothing in the body moves them out (a capture consumed by an
  `own` parameter is dup'd by the evaluator).

## Gates

- `tests/async_await.test.yo` "an io.async closure releases its captured values when the
  future dies": a ref and an `Option(ref)` captured by a sync-future body and by a state
  machine are each disposed exactly once; a captured `String` reads back intact after an
  await. Each await sits in its own `{ }` block — a top-level `io.await`'s future temp is
  released by the SCOPE-END drops, not at the statement, so the count is read after the
  block closes. Red-first (0/1/1/1 on the pre-fix compiler).
- The "borrowed arm value: released exactly once" test in the same file — its
  `Option(_BpHandle)` parameter capture is what the arm-dup fix had exposed as a leak.
- Fast suite, gen-1/gen-2 fixpoint and the CLI corpus (the compiler's own async code is
  the largest consumer).
