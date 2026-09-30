# The `ref` JoinHandle (#991) left value-shape emitters: Linux stage-1 C errors, develop battery red

**Severity:** S1 — every develop PR battery is red at stage-1 since #991 (the seed cannot emit the new `extern("Yo", __yo_join_handle_release_raw)`)

**Status: OPEN** — resolution in flight as #996 (JoinHandle back to the seed-lowerable value struct), matching the path this doc prescribes.

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

## Root cause (refined 2026-09-29)

Not three independent emitter bugs — a **seed-gating violation**. #991 added
to `std/prelude.yo` the extern

```rust
extern("Yo", __yo_join_handle_release_raw : (fn(fut : *(void)) -> unit));
```

and `JoinHandle`'s `Dispose` calls it. An `extern("Yo", …)` name is emitted
by the COMPILING compiler's built-in async runtime — and the SEED (v0.2.45)
predates #991's runtime, so a seed-compiled build emits the call sites with no
definition anywhere in the C (Linux gcc/clang reject the implicit declaration;
the shapes reported above — the `(__yo_t_X*){ .__future = … }` compound
literal and the `.__future` dot-reads — are the same mismatch seen from the
call-site side). This is exactly the rule
`plans/backlog/SEED_VERSION_AUTOMATION.md` / AGENTS.md state for std: std may
not use a runtime builtin the pinned seed does not carry. A Windows
seed-build happens to compile (the dispose call sites are not emitted the
same way there), which is why the breakage surfaced only in the Linux
battery.

Resolution belongs to the async campaign (#991's follow-up phases): either the
tree avoids the new extern until a release carries it (a fallback drop), or a
release with #991's runtime ships and `SEED_VERSION` bumps past it. Until
then every PR battery on develop inherits this red at stage-1.

## Note

This is inside the active `plans/backlog/ASYNC_STATE_MACHINE_GENERATION.md`
campaign (phases 0–1 = #989, 2–3 = #991, both merged 2026-09-28): the fix
belongs with that work's next phase rather than a parallel patch — filed so
the red battery has a diagnosis attached. Nothing Linux-specific exists in
the shapes themselves; Linux is simply the only platform whose battery
compiles the compiler (a Windows local build of the pre-#991 tree passes, and
the same source compiled after #991 produces the identical invalid C on any
platform).
