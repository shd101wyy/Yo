# yo-self: two `io.async` blocks in one function cross their struct/capture metadata

## Status

OPEN. Two `io.async(...)` calls (each later awaited) in the same function emit C
that crosses the two async blocks' state-machine struct types and capture types.

The sibling bug — duplicate C temp names (`__sync_future`, `__pre_await_state`,
`__sync_await_result`, `__io_async_result`) across multiple `io.await`/`io.async`
calls — is FIXED (uniquified by the call's expr id; see await.yo / async.yo).

## Reproducer

```rust
{ println } :: import("std/fmt");
Point :: object(x : i32, y : i32);
run :: (fn(io : Io) -> i32)({
  t1 := io.async((io : Io) => Point(i32(40), i32(2)));
  t2 := io.async((io : Io) => Point(i32(10), i32(20)));
  p1 := io.await(t1, io);
  p2 := io.await(t2, io);
  (p1.x + p1.y) + (p2.x + p2.y)
});
main :: (fn(io : Io) -> unit)({ println(run(io)); });
export(main);
```

- **TS reference**: prints `72`.
- **yo-self-bin**: C error —
  `assigning to '__yo_capture_yo_id_5633' from incompatible type
  '__yo_capture_yo_id_5630'`.

## Observed C (the crossing)

```c
io_async_block_yo_id_5660_sync_fut_t* __io_async_result_34534 =
    (io_async_block_yo_id_5658_sync_fut_t*)__yo_malloc(sizeof(io_async_block_yo_id_5658_sync_fut_t));
...
__io_async_result_34534->__capture = (__yo_capture_yo_id_5630){0};
```

The variable is DECLARED as `…5660_sync_fut_t*` (the future type's struct name)
but ALLOCATED as `…5658_sync_fut_t` — two different state-machine struct names for
the SAME call. And `t2`'s capture (`5633`) gets assigned a `5630` value.

## Likely cause

The async-block state-machine struct name / capture-type metadata for the two
closures collide — the body-emission path (`generate_io_async_sync_call`) computes
one struct name (5658) while the binding's declared future type carries another
(5660). This is the same class as the closure metadata side-tables
(`g_closure_capture_info`, `g_closure_await_analysis`,
`async_state_machine_struct_name` on ExprInfo): a keying that is not unique per
io.async call site, so the second block's metadata leaks into / overwrites the
first's (or the declared-vs-emitted names are produced by two different counters
that don't agree).

## Fix direction

Ensure the async-block struct name + capture type are keyed uniquely per io.async
call site (e.g. by the call's expr id, as the temp-name fix now does) AND that the
SAME name is used by both (a) the future TYPE recorded on the binding's ExprInfo
(used for the C declaration) and (b) `generate_io_async_sync_call`'s body
emission. Single-async-block functions are unaffected (only one name, no
collision) — which is why all current corpus fixtures pass.
