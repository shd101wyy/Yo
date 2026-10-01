# macOS async I/O performance: handover

**Status: ACTIVE handover, 2026-10-01**, for an agent on another machine.
The goal: macOS async I/O performance at or above libuv's, with every bug
found on the way documented and fixed, and no workarounds. The authoritative
measurements are `plans/reference/MACOS_ASYNC_IO_PERFORMANCE.md`; the
wrapper half of the plan is `plans/backlog/ASYNC_AWAIT_SITE_FUSION.md`.

## 1. Where it stands

- **The raw runtime**, `scripts/bench-vs-libuv.sh`: at or above libuv on
  file, timers and TCP since #988. The socketpair echo row was 0.86 of
  libuv's on macOS at #988, from two entry-point costs: `send` over `write`,
  and the per-park `EV_ENABLE`. Both are written up in the reference doc's
  §4–§5.
- **The std layer** (`scripts/bench/async-vs-libuv/bench.yo` against
  `bench_uv.c`, µs per round trip, medians):

  | Row | before #1074 | after #1074 | libuv |
  | --- | ---: | ---: | ---: |
  | `multi` (8 connections) | 3.70 | 3.54 | 3.19 |
  | `pingpong` (1 connection) | 15.24 | 14.47 | 13.79 |

  Those numbers predate await-site fusion. The remaining gap is std's
  per-operation `io.async` wrappers, which fusion removes.
- **Await-site fusion** (#1073, not merged): with it on, std costs the same
  as the raw op under it. In `scripts/bench-std-vs-raw.sh` std/raw is 1.01 on
  the 8-connection ping-pong and 1.00 on inline sends; with it off, 1.03 and
  1.01. **The std-vs-libuv rows above have not been re-measured with fusion
  on.** That is open work item 3.

## 2. What landed in this session (2026-09-28 → 10-01)

- **macOS runtime:**
  - #988: the audit plus performance work: dispatch knotes, the slot table,
    the timer heap, deadline-bounded waits, the watch kqueue.
  - #999: every backend's init arms the thread-exit hook.
  - #1004: Linux's recv-park hint.
  - #1005 and #1007: on Windows the backend holds every pending future, and
    pipe writes run on the thread pool.
- **Stream writes:**
  - #1019: the `__yo_async_stream_write_start` op.
  - #1074: std/net streams take it, so they write with `write(2)` and
    `SO_NOSIGPIPE` on macOS and `send(MSG_NOSIGNAL)` on Linux.
- **Bugs found on the way:**
  - #1031: a closure inside `io.async` emitted invalid C.
  - #1055: emscripten's read_dir stream list was process-global.
  - #1056: develop's red tests.
  - #1089: five async issues closed against their original evidence, and a
    raw extern I/O future awaited as a temporary leaked (a codegen bug).
- **Await-site fusion F0–F3:** the plan is #1013. F3 (#1085) is merged into
  #1073's branch, which is open (§3.0).

## 3.0 The branches

**Update 2026-10-02 (taken over by another session).** Items 1 and 2 have moved:

- **Item 1 is done as #1099**, stacked on #1093 (`async-triage`). #1093 pre-registers async block types before the type declarations (`src/codegen/codegen_c.yo`). That removes the two C spellings at their source, and all three generic-aggregate shapes pass with it, including shape 1 (`Option(*T)`), which #1090's casts still failed. So #1099 keeps #1090's evaluator fix (`_is_future_handle_slot`), its doc and its three tests, and drops the casts. #1090 is superseded; close it when #1099 lands.
- **Item 2:** #1075 has landed. The integration branch `int/fusion-on-triage` is develop + #1093 + #1099 + #1073. It found one integration bug: fused wrapper locals had no move flag in the caller's struct (`issues/fixed/a-fused-wrappers-named-local-has-no-move-flag-in-the-callers-struct.md`). It is fixed on that branch in commit `30e0abe4f`, which #1073 must carry once it is rebased on a develop that has #1093. With the fix, the fusion, `sm_ownership`, `sm_protocol` and `async_await` tests pass with fusion on and off (12 / 35 / 15 / 261). The fixpoint waits for develop's #1098 breakage (a `?=` default check that rejects develop's own `src/`) to be fixed.
- **Merge order:** #1093, then #1099 (retarget to develop), then #1073 rebased with `30e0abe4f`, then close #1090.

| Branch | PR | Head | State |
| --- | --- | --- | --- |
| `perf/await-site-fusion` | #1073 | `97fac3a17` | ready after #1093; needs the integration fix `30e0abe4f` (§3, item 2) |
| `fix/generic-aggregate-future-field` | #1090 | `f961f549d` | superseded by #1099 (§3, item 1) |
| `fix/generic-dispose-over-future` | #1099 | | draft, stacked on #1093; local gates pass |
| `int/fusion-on-triage` | none | `30e0abe4f` | integration gate branch; not for merging |

## 3. Open work, in order

### 1. #1090: finish the generic-aggregate future fix

`issues/an-io-async-future-in-a-generic-struct-field-lowers-to-two-c-types.md`
(S2) and its third shape, filed separately as
`issues/a-generic-impl-dispose-never-runs-for-a-type-fn-instance-at-a-future.md`
(S2).

**The two fixes on the branch:**

- **Two C spellings.** An aggregate's typedef is emitted while its future
  type variable is still unresolved, so it uses the erased interface. Stores
  and reads come later, after the variable has resolved to the state machine.
  - Each typedef records the C type it declared every field with
    (`CodeGenContext.aggregate_field_c_types`,
    `record_aggregate_field_c_type`).
  - `aggregate_field_store` and `aggregate_field_read` (`src/codegen/utils/index.yo`)
    cast to and from that record. The call sites are the ref-struct and
    ref-enum constructor bodies (`functions/constructors.yo`), the
    value-struct and value-enum literals (`exprs/other_fn_call.yo`), and the
    match payload and nullable-pointer bindings (`exprs/match.yo`).
- **The generic `Dispose`.** `_bind_forall_from_type_args`
  (`src/evaluator/values/impl.yo`) now binds a future handle as itself
  (`_is_future_handle_slot`), so `impl(generic(T), G(T), Dispose)` matches
  `G(<future>)`.

**Gate result** (tree-built compiler on `f961f549d`; the gate was stopped
during the fast suite):

| Check | Result |
| --- | --- |
| shape 2, `Option(T)` value field | fixed: compiles, prints 8, 0 leaks |
| shape 3, the generic `Dispose` | fixed: prints `guard released`, 0 leaks |
| shape 1, `Option(*(T))` field | **still fails**: `incompatible pointer types assigning to '__yo_t_8381…**' from '…_sync_fut_t **'` at `obj->r = r;` in the ref-struct constructor |
| `tests/async/sm_ownership.test.yo` | batch fails to compile (shape 1's test), so the fast suite stops there |
| combinators, join_handle, async_await | pass (37, 6, 259) |

**What is left for shape 1:**

1. Widen the predicate. The field's type is `Option(*(T))`, a
   nullable-pointer-optimized enum whose C type is the pointer itself. The
   predicate `_field_type_has_late_future` looks through `Pointer` and the
   type variable only. Make it look through an enum that
   `can_optimize_as_nullable_pointer` lowers to that pointer.
2. Check the read side. The constructor's store key is `<struct>.<field>`,
   and the nullable `Option` field's value is the pointer. Confirm that a
   read of the field into an `Option(*(T))` local takes the cast too.
3. Rebuild, then run `tmp/gsf1.yo` (in the issue doc: the `_Holder`/`_wrap`
   shape) and `tests/async/sm_ownership.test.yo`.

**Then:**

- Merge develop in. Expect a conflict in `tests/async/sm_ownership.test.yo`:
  #1089 and #1090 both append tests at the end. Keep both, and close the
  first test (`});`) before the second's comment starts.
- Move both issue docs to `issues/fixed/` with the measurements, and
  regenerate `issues/TRIAGE.md`.
- Run the full gate (§4).

### 2. Merge #1073 (await-site fusion F0–F3, on by default)

Its gates passed on an earlier tree:

- **F2 differential**, lowering on: the fast suite passed 4,876, and
  `gates_fast` was clean except #1018's three rc 139 cases (fixed since by
  #1072).
- **The F2 fixpoint with the lowering on:** holds.
- **F3's gate:** fusion tests 12/12 on and off, the fast suite 4,880,
  `FIXPOINT_HOLDS`.
- **Size:** `yo.c` +0.30%.

Since then develop came in, including #1071's codegen changes, which
auto-merged into `async.yo` and `codegen_c.yo` without being built. So gate
the merged tree again.

**Order:**

1. **#1075 first** (yo-7a's ATS stack). It adds E0617: an expression
   statement may not drop a `Result` or a future. It already found 39 such
   statements in `tests/`. Landing it after fusion could turn develop red
   on code its gate never saw.
2. **Then one integration gate** on develop + #1073 + #1090.
3. **Then merge #1073**, then #1090.

`scripts/` has no copy of the integration gate. It does:

- merge both branches onto develop, stopping on a conflict;
- `yo build`;
- the fusion and sm_ownership tests with `YO_ASYNC_FUSION` unset (on) and
  `=0` (off);
- the fast suite;
- `gates_fast.sh`;
- `fixpoint_only.sh`;
- `scripts/bench-std-vs-raw.sh`, whose raw side now takes `stream_write` like
  std.

### 3. Re-measure std against libuv with fusion and stream_write in

Run `scripts/bench-vs-libuv.sh` and the std-level pair (`bench.yo` against
`bench_uv.c`, `multi` and `pingpong`, interleaved, medians) on develop
after #1073. Record the result in
`plans/reference/MACOS_ASYNC_IO_PERFORMANCE.md`. If the std rows still trail
libuv, profile them: a callgrind instruction count per op, or the emitted C
of `TcpStream.read` / `write` after fusion.

### 4. F3's exit measurement

The plan's F3 exit: an HTTPS GET makes no wrapper allocation per read,
counted with a `__yo_rc_alloc` counter in the emitted C. Not measured.
`YO_DEBUG_FUSION=1` on an HTTPS client shows which `TlsStream`/`BufReader`
awaits fuse, and which §3.1 rule rejects the rest.

### 5. The raw socketpair row

The socketpair echo was 0.86 of libuv's. Its two costs, `send` over `write`
on sockets std does not own, and the per-park `EV_ENABLE`, are analysed with
the rejected alternatives in the reference doc §5. Any new attempt starts
from that section.

## 4. How to gate (this machine's experience)

- **The local battery for a codegen change:**
  - `yo build` with `YO_STD=<tree>/std`;
  - the targeted tests with the tree-built binary, never the seed;
  - `yo test ./tests --exclude tests/internal --exclude tests/cli-cases`;
  - `S1=<bin> P=<prefix> bash scripts/bootstrap/gates_fast.sh`;
  - `scripts/bootstrap/fixpoint_only.sh`.

  `yo check` is a filter, not a gate: it passed every file whose C was
  broken here.
- **Fusion A/B:** `YO_ASYNC_FUSION=0` turns the lowering off.
  `YO_DEBUG_FUSION=1` prints each await's verdict, and the
  `async-await-fusion-*` CLI cases pin them.
- **Leaks on macOS:** `leaks --atExit -- ./bin`, built with
  `--allocator system`. A standalone `--sanitize address` binary runs on
  macOS; the test runner's ASan does not.
- **A fixed-heap CLI case is a leak oracle** a test can't otherwise express.
  `build.Allocator.Fixed` with `heap_size : usize(65536)`; the leak panics
  `out of memory`. See `tests/cli-cases/raw-extern-future-sync-await-releases`.
- **A red-before must be read for its reason.**
  - A std copy outside a directory named `std` fails with `"unsafe" names a
    builtin`: the prelude is treated as user code.
  - `rc=1` with no assertion text needs `-v`.
- **Goldens that move with unrelated edits:**
  - Editing any `.github/skills/*` file changes the hash in 7 tree goldens
    (the init and skills-install cases). Substitute the new sha256, then run
    those cases.
  - `lsp-member-definition` pins the line of `ArrayList.push` in
    `std/collections/array_list.yo`.
  - `compile-profile` pins the fixture's std function count.
- **Emscripten:** CI uses 6.0.6. The nix emcc 4.0.12 fails every thread test.
- **Scripted edits:**
  - Assert each anchor's count before replacing.
  - Never cut a definition at a generic `});`: a `name :: (fn…)(expr)` body
    ends in `)`.
  - A Yo block body cannot start with `match(` or `cond(`.
- **A branch made from `origin/develop` tracks develop.** Its first push is
  `git push -u origin <branch>`. Never follow git's `HEAD:develop` hint.
