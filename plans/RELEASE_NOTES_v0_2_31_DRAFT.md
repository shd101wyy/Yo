# v0.2.31

**Draft.** The release workflow fills the GitHub body from the last commit
message only, so these notes are edited in by hand from this file at publish
time (same as v0.2.26–v0.2.30). Archive it to `plans/archive/` with a banner
once the release ships.

This is the std API stabilization campaign's concurrency and documentation
half, plus the build system's dependency resolution finally working end to
end. **No breaking changes** — the breaking window shipped in v0.2.28.

## Async: `abort()` gives back what the task was waiting on (#590)

`JoinHandle.abort()` was a state word and nothing else. The operation the task
was suspended IN stayed registered with the I/O backend, so everything it held
— the operation's future, the state machine, its captures — was retained until
that operation completed on its own. `timeout` does exactly that on every
call: a task that beat its deadline left the deadline timer armed for the
whole remaining limit.

Measured on `issues/repros/timeout-deadline-timer-retained.yo`, 800 in-time
calls against a 9 s deadline:

| | live allocations at exit | bytes |
| --- | --- | --- |
| before | 3387 | 233 KB |
| after | **187** | **33 KB** |

187 is the zero-call baseline, so the per-call retention is gone rather than
reduced. `__yo_io_future_t` gained a `cancel_fn` the `*_start` function fills
in; `__yo_async_io_cancel` arbitrates (it cancels only a still-pending future
whose continuation registration it takes, so a completion already in flight
keeps ownership of the wake); timers on all four backends have a cancel path
(kqueue `EV_DELETE`, `IORING_OP_ASYNC_CANCEL`, list unlink on Windows and
wasm); and a per-async-block `cancel_pending_fn` on the spawned-future header
does eagerly what the resume function's aborted-entry guard did lazily.

Operations with no cancel path keep the old lazy release, so nothing
regresses: a task aborted while parked on a socket read still holds that read
until it completes.

## Async: the waker, and the primitives built on it

- **A real `Waker`/`park` primitive** (#561) — the thing every peer-waiting
  primitive needed. `yield_now` drops the 1 ms floor.
- **`Mutex` over a waiter queue** (#576) — `unlock` wakes the front waiter;
  acquisition is FIFO, with a test that wakes N waiters from one signal and
  asserts all N ran.
- **`Channel` over the same queue** (#586) — `send`/`recv` park instead of
  re-checking on a 1 ms tick.
- **A `Stream` trait** (#555) — the async analogue of `Iterator`, and
  `TcpListener.incoming` on top of it.
- **`Sender`/`Receiver` split** (#553) with auto-close on the last sender.
- `race_first` / `any_first` (#550).

## Build: a dependency's imports actually resolve (#581, #583, #577)

`import("<dep>")` used to go nowhere: the runner never passed an import
mapping to the child compile. It does now (`--imports`), including a
dependency's OWN imports, transitively. `build.yo` evaluation errors are
reported instead of swallowed, linked static libraries reach the link, and
`shared_library` is rejected rather than silently compiled as an executable.
Static libraries export their functions under plain external names (#578).

## Documentation: `yo doc` publishes what the source says (#579, #589, #591)

Three extractor defects, each measured against `yo doc ./std --format json`:

| | undocumented / total |
| --- | --- |
| before | 1554 / 3345 |
| a trait-impl method inherits the trait's doc (#579) | — |
| a re-exported declaration carries the declaring module's docs (#589) | 1293 / 3345 |
| the prelude is not an empty page (#591) | **1161** / 3368 |

`std/prelude.yo` rendered with **zero members** — 12k lines declaring
`Option`, `Result`, `Box`, `Io`, `JoinHandle`, the numeric types and every
core trait — because the cached-prelude load outcome described nothing. It
publishes 957 items now, and its 31 traits are donors for the impls that
inherit their documentation. A DERIVED impl counts as a trait impl too, which
is what `source` and the operator families were waiting on.

## Compiler fixes

- **Awaiting a future held in a struct FIELD released it twice** (#580) — a
  heap-use-after-free that failed every CI leg under ASan.
- **A dup taken in a deeper scope cannot cancel an outer local's drop** (#574).
- **Only a CONCRETE type can be trace-monomorphized** (#586).
- **Five defects in one batch** (#562): escape scanning, a spawn-capture leak
  and the dup/drop cancellation that made releasing it unsafe, a module global
  lost across an async suspension, a silently-zero array length.
- **`c_include`: a `Name : Type` field ADOPTS the Yo type of that name** (#582).
- Two codegen fixes riding with `BITS`/`T.Unsigned` (#548).
- **Nested `cond`/`match` arms in an async body dispatch by code on the shared
  field** (#592) — six emitter bugs in one, including the dead arm that made
  `yo install user/repo@tag` write `ref: ""`.

## std

- `std/encoding/toml` is a real TOML v1.0.0 parser and serializer (#554) —
  the old line-based subset silently corrupted twelve inputs.
- The module-prefix stutter is gone from `std/encoding` (#558).
- `imm`'s `extract` — the remove that reports what it removed (#552).
- `OrderedMap` gains a position index: `swap_remove`, `index_of`, `get_index`
  (#550).
- `Child` pipes are `Reader`/`Writer` handles; `Watcher` gained the `Dispose`
  it never had (#546).
- `try_with_lock`, `wait_timeout`, and the `RwLock` `try_*` pair (#545).
- `BITS` + `T.Unsigned`, with the ten bit batteries collapsed onto them (#548).
- **All 175 modules carry a `## Stability` marker** (#575), and 359
  previously undocumented members gained one (#559).

## Tooling

- **`--allocator fixed`** — a hand-written TLSF allocator over one static
  `.bss` region, with `--heap-size` and a `--debug-heap` live-at-exit leak
  oracle (#542).
- **`--profile` is real**: per-phase timing, a per-module table, JSON (#540).
- A dev build profile: `--emit-chunks auto` and a DEBUG `yo build` default
  (#541).
- The verifier reaches V3 datatypes (#535), V4 loops and exits (#538) and V5's
  first row — two-state `old()` (#557).
- Discarded calls are written as bare statements rather than `_ :=` / `___ :=`
  bindings across the tree (#594, docs in #595).

## Known residuals

- A task aborted while parked on a socket read, a `getaddrinfo` or a waker
  still holds that operation until it completes: only timers have a cancel
  path so far.
- `race`/`any` still poll rather than park —
  `plans/WAKER_BASED_SCHEDULING.md` step 4.
- D18b (`Thread(T).join() -> T`) is still open. Its three blockers are now
  separately diagnosed and none of them is the spawn lowering that
  `issues/thread-spawn-callback-returning-a-zst-emits-void-star-from-void.md`
  used to blame. The first — a static-dispatch call reading the CALL
  EXPRESSION's type instead of the callee's prototype, so a `void`-returning
  closure call was bound to a `void*` temp — is fixed in #598, which lands
  after this release. The other two are
  `issues/generic-channel-send-specialisation-is-called-but-never-emitted.md`
  — one specialisation mangled two ways, so it is emitted under one name and
  called under another — and `_capture_judgement_type` resolving a captured
  closure to its capture STRUCT and then rejecting it as not `Send`.
- A body-less HTTP response can go unread until its deadline on some CI
  runners (`issues/a-bodyless-http-response-is-not-read-until-the-deadline.md`).
  The read completes with the whole response in hand and the exchange still
  times out, so what is lost sits above the read; the tagged checkpoints that
  separate the two remaining candidates are on the #556 branch.
