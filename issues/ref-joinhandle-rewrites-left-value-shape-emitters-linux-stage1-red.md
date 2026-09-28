# The `ref` JoinHandle (#991) left value-shape emitters: Linux stage-1 C errors, develop battery red

**Opened:** 2026-09-29
**Introduced by:** #991 (`c52ce152c`, "Async state machines, phases 2–3: … owning
JoinHandle"), which changed `JoinHandle` from `struct(__future : *(T))` to
`ref(struct(__future : *(T)))`.
**Measured on:** develop `c52ce152c` and `34c51c895` — CI "Build stage 1 once
(seed `yo build`)" fails in the C compile; the whole battery cascades (the
suite-c artifact never uploads, every test job dies on artifact download).
The last green develop battery is `af62bdb28` (#982, 2026-09-28 14:08).

## Verbatim (gcc, yo-out/x86_64-unknown-linux-gnu/bin/yo.c)

```
error: call to undeclared function '__yo_join_handle_release_raw'; ISO C99 and later do not support implicit function declarations
  1645383 |   __yo_join_handle_release_raw(((void*)(self->__future)));

error: initialization of non-aggregate type '__yo_t_4247868470200716521 *' with a designated initializer list
  1672842 |   sm->var_h_9557120579125211127 = (__yo_t_4247868470200716521*){ .__future = (void*)__spawn_future__file____home_temp_7562692439026389592 };

error: member reference type '__yo_t_4247868470200716521 *' is a pointer; did you mean to use '->'?
  1673138 |   void* __jh_future__file____home_temp_145980945840659789671 = sm->var_h_9557120579125211127.__future;
```

The failing sites are the compiler's own async code (`src/build_runner.yo`'s
`handles.push(e.io.spawn(...))`, `err_task`, `t := e.io.spawn(...)`, …) — the
spawn/join shapes every `io.spawn` in an `io.async` body takes.

## Root cause

Three emitters still produce the OLD value-struct shapes now that
`JoinHandle(T)` is reference-semantics (a pointer in C):

1. **Spawn construction** — `src/codegen/exprs/generation.yo`
   `_generate_io_spawn` returns
   `` `(${jh}){ .__future = (void*)${spawn_var} }` `` — a compound literal
   cast; with `jh` now `__yo_t_X*` that is an invalid C initialization. A
   ref-semantics struct is constructed through its `__yo_new_*` constructor
   (or the handle must be built another way the new ownership model wants).
2. **Handle field reads** — the join/await path reads `sm->var_h.__future`
   with `.` where the SM field now holds a pointer (`->`).
3. **`__yo_join_handle_release_raw`** — called by the (generated) dispose of
   the owning handle, but no runtime defines it:
   `src/codegen/async/runtime_core.yo` has only `__yo_join_handle_state_raw`
   and `__yo_join_handle_abort_raw`. Either the release helper is missing from
   the runtime or the dispose should call the shared complete/abort protocol
   helpers the phase-2 plan prescribes ("one protocol helper per transition").

## Note

This is inside the active `plans/backlog/ASYNC_STATE_MACHINE_GENERATION.md`
campaign (phases 0–1 = #989, 2–3 = #991, both merged 2026-09-28): the fix
belongs with that work's next phase rather than a parallel patch — filed so
the red battery has a diagnosis attached. Nothing Linux-specific exists in
the shapes themselves; Linux is simply the only platform whose battery
compiles the compiler (a Windows local build of the pre-#991 tree passes, and
the same source compiled after #991 produces the identical invalid C on any
platform).
