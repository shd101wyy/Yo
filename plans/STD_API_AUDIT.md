# std API audit — the road to a stable, batteries-included standard library

**Status: IN PROGRESS.** Audit complete 2026-08-22; all §8 open questions
DECIDED by the user 2026-08-23; **S0, S1 and almost all of S2 are LANDED**
(PRs #229–#294, 2026-08-23 → 2026-08-26). Remaining: D6 (TLS —
executable plan in plans/D6_TLS_PLAN.md), the §7 S4/P1 tail, §9 S5 stability
freeze, and the seed-gated queue (plans/backlog/SEED_VERSION_AUTOMATION.md).
D4 PR 9 closed BY EVENTS 2026-08-28: the vendor migrated upstream
(markdown_yo ff51f91 — zero substring sites remain, and its byte-based
decoders are CORRECT by construction under the byte-indexed String), the
pointer is at the migrated commit, and the docs pipeline runs it green end
to end. D5 closed except the SEED-GATED bufio consumer migration (recorded
in the backlog doc).

> **Condensed 2026-08-26.** The execution narratives for landed work were
> trimmed to short records; the full history lives in this file's git history,
> the PR trail, and `issues/` (fixed bugs are in `issues/fixed/` with
> mechanisms and reproducers). Operational knowledge lives in
> `plans/STD_API_AUDIT_HANDOVER.md` (the battery script, the measurement
> traps, the working method) and `plans/STD_API_AUDIT_D4_PLAN.md` (the
> string-indexing sub-plan). Per the handover: **rows in this file have
> repeatedly measured wrong — re-measure before executing, and correct the
> row in the same PR.**

Method: six parallel full-surface catalog sweeps (core/prelude,
collections+imm, strings+encoding, io/fs/os, net/async/sync, time/crypto/build)
over all 144 files / ~44k lines of `std/`, cross-checked against Rust std,
Python, and Node, plus repo-wide import-usage scans. Goal per the user: *"battery
included, like rust, python and nodejs … I hope the std API is stable so we wont
change much in the future."*

The audit found three kinds of work, in priority order:

1. **Correctness bugs** hiding in std (one security-grade) — fix first, no API
   debate needed (§2).
2. **Convention decisions + breaking renames/deletions** — everything breaking
   happens in ONE release window, before any stability promise (§3–§6).
3. **Additions** that make Yo batteries-included (§7), landed behind the now-fixed
   conventions so they never need to change again.

---

## 1. Guiding principles (the stability contract)

- **One blessed error style per situation** (§3 D1). Modules currently ship four
  styles, sometimes in one file.
- **One name per concept across the whole tree** (§3 D2). Today: 5 insert verbs,
  4 spellings of the length field, 2 `sleep`s, 2 `Writer`s, 3 `spawn`s.
- **Traits are the API.** Inherent methods that duplicate a trait (e.g.
  `HttpRequest.to_string`) become trait impls. Types that should compose
  (`Eq`/`Ord`/`Hash`/`Clone`/`ToString`) get the impls.
- **`sys/` is plumbing, `std/*` is the product.** Every user-relevant syscall
  gets a typed wrapper; underscore-private names never appear in `export(...)`.
- **Nothing dead ships.** Zero-consumer modules are deleted or promoted (wired in
  and tested) — never left ambient.
- After the breaking window closes: **additive-only** changes to stable modules;
  new modules enter via an `unstable` doc marker for one release before freezing.

---

## 2. Correctness bugs found by the audit

§2 is COMPLETE except the OPEN compiler rows below. Fixed rows are one-line
records; mechanisms and reproducers are in the named `issues/fixed/` docs.

| # | Bug | Status |
|---|-----|--------|
| C1 | `https://` silently downgraded to cleartext HTTP; `fetch` must throw `UnsupportedScheme` until TLS exists | **FIXED** PR #229; **https now speaks real TLS** 2026-08-28 (D6 PR-2 — `std/http` routes https through `TlsStream`, live example.com fetch pinned) |
| C2 | `_make_sockaddr` hardcoded `::1` for every IPv6 addr; `accept` fabricated peer IP; `local_addr` echoed the bind arg (no `getsockname`) | **FIXED** PR #229 |
| C3 | `lookup_host` silently dropped every AAAA record | **FIXED** PR #229 |
| C4 | `DateTime.to_string` always emitted `Z`, ignoring `utc_offset_secs` | **FIXED** PR #229 |
| C5 | `crypto.random_range` modulo-biased; `random_f64` closed `[0,1]` | **FIXED** PR #229 |
| C6 | float bitwise / unsigned `Negate` prelude impls (the bool-arithmetic half of the row was stale — no such impls existed) | **FIXED** 2026-08-23 |
| C7 | reclassified → **O7** (imm atomic-RC cycle leak): require `Acyclic` on imm element types. **LANDED 2026-08-27** (see O7 — enforcement verified both ways; sync-container residual recorded there) | **FIXED** |
| C8 | `Channel.send` dropped the value on failure | **FIXED** 2026-08-23 |
| C9 | `WalkOptions.follow_symlinks` declared, never read | **FIXED** PR #229 |
| C10 | `clock_gettime` return code discarded (failing clock yields epoch) | **FIXED** 2026-08-23 (failure unreachable in test) |
| C11 | `decode_html` overflow hacks; `html_entities` runtime map crashed clang at -O0 (module untestable); `&forall;` data bug | **FIXED** 2026-08-24 — issues/fixed/html-entities-runtime-map-uncompilable-in-tests.md |
| C12 | row was stale (BufWriter/Temp `Dispose` already existed) — but it uncovered TWO compiler bugs: a future's owned RC result was never dropped, and the async post-while branch cleanup double-dropped (issues/fixed: async-future-result-never-dropped, async-postwhile-branch-cleanup-double-drop); plus the Windows `write_sync` OVERLAPPED shim (2026-08-24). NOTE, load-bearing for D5: BufWriter's `Dispose` is a SYNC best-effort flush — a sync `dispose` cannot await an async `Writer.write`, which is exactly what makes "BufWriter wraps any Writer" structurally hard | **FIXED** |
| C13 | doc claims vs reality (rwlock atomicity, `Drop` vs `Dispose`, phantom methods, nonexistent barrel imports) | **FIXED** 2026-08-23 |
| C14 | `File` never tracked its position — pread/pwrite offset hardcoded 0, `seek` a silent no-op | **FIXED** PR #277 (`File._pos`, red-first) |
| C15 | `RwLock.write_unlock` never woke blocked readers (red-first test HANGS 300 s) | **FIXED** 2026-08-25 |
| C16 | async trait `?=` default hollowed (evaluated under the impl's ambient ctx, so `io.async` couldn't bind its effect generic; the def-eval-wall swallowed it) — was D5's blocker | **FIXED** 2026-08-26 — issues/fixed/trait-default-awaiting-self-async-method-emits-hollow-fn.md, tests/async_trait_default_await.test.yo |
| C17 | `Dyn(trait)` whose method returns `Impl(Future(...))` emits the on-demand Future struct INTO the open vtable typedef; clang rejects with 7 errors. Blocks the `Dyn(Reader)` spelling of "BufReader wraps ANY Reader" | **OPEN** — issues/dyn-trait-with-future-returning-method-splices-struct-into-vtable.md |
| C18 | **A struct literal that OMITS a required field is silently accepted** — `yo check` green, field uninitialised, program SIGSEGVs. Root: the check FIRED but was SWALLOWED in async-closure/generic def-eval, leaving codegen no ExprInfo → FTT object; **FIXED 2026-08-28** (missing-field error flags the flow-violation channel so the swallow re-raises it at check time — tests/struct_missing_field.test.yo). Directly undermines §1's "additive-only" promise: adding a field to a stable struct silently breaks every construction site not updated | **FIXED** — issues/fixed/struct-literal-missing-field-silently-accepted.md |
| C19 | C `int` passed where `i32` declared is accepted by the evaluator; codegen splices a Yo type expr into a C identifier, clang fails with a diagnostic naming nothing the user wrote | **OPEN** — issues/int-vs-i32-mismatch-reaches-codegen-and-emits-malformed-c.md |
| C20 | generic-`R` callback with a unit-returning closure emitted `void* tmp = <void call>;` — `Mutex.with_lock((v) => { … })`, the flagship std/sync form, did not C-compile | **FIXED** 2026-08-26 — issues/fixed/generic-r-callback-with-unit-closure-emits-void-star-temp.md |
| C21 | a materialized async trait `?=` default resolved its `Impl(Future(...))` return to ONE concrete state-machine type for ALL implementors (`-Wincompatible-pointer-types` across implementors), ESCALATING to a hard `incomplete definition of type` C error on D5's generic BufReader (a TRIAL-era never-emitted state struct). **FIXED 2026-08-27** in two layers: per-materialization fresh RETURN SomeT cells (`_freshen_return_only_somes`, impl.yo) + emission-layer callee-channel future types (`awaited_future_c_type_override` — the sm field and the call temp now name the CALLEE's emitted return, so the static type always matches the dynamic object). Gate: the two-implementor reproducer compiles with ZERO incompatible-pointer warnings | **FIXED** — issues/fixed/async-trait-default-shares-one-impl-future-concrete-type.md |
| C22 | a closure defined INSIDE an `io.async` closure body makes that body untranspilable — compile exits 0, clang clean, binary is rc=134 (`abort()` stub), future is `_sync_fut_t` | **OPEN** — issues/closure-nested-inside-io-async-closure-body-emits-abort-stub.md |
| C23 | generic implementor (`impl(generic(T), Wrap(T), …)`) awaiting `Self.<async method>` emitted uncompilable C — two defects: static-dot `-> Self` resolution clobbered SomeT returns with the receiver, and `substitute` was not capture-avoiding (the impl's `T := usize` rewrote `Io.async`'s own `T` binder) | **FIXED** 2026-08-26 — issues/fixed/generic-implementor-async-method-awaiting-self-emits-uncompilable-c.md, tests/generic_impl_async_self.test.yo |
| C24 | **async loop over a buffer-taking await** (the D5 slice-2 blocker, found by D5 work): (a) a generic fn's `io.async` closure DROPPED the enclosing params from its capture (the `.AsyncBlock` classifier arm kept a generation-unsafe frame-level test); (b) the nullable-ptr match's payload binding (`.Some(q) => q` over `chunk.ptr()`) declared a C local while arm reads consulted the never-written hoisted `sm->var_N` slot — silent rc=139 on fully-transpiled C. Both **FIXED** 2026-08-26 (PRs #294 + #295; tests/async_generic_param_capture.test.yo, tests/async_loop_buffer_await.test.yo). (c) the generic-impl face — a materialized generic-impl arm body read the match binding through an evaluator-stamped temp the nullable-ptr emitter never shadow-registered (`_shadow_add`, the mechanism the tagged-union path always used) — **FIXED** 2026-08-26 too. ALL THREE FACETS CLOSED; generic `BufReader(R)`/`BufWriter(W)` unblocked (C17 still blocks only the `Dyn(Reader)` spelling) | **FIXED** — issues/fixed/async-loop-awaiting-buffer-taking-method-state-machine-corruption.md |
| C26 | **`out = e.io.await(...)` — RE-assigning (`=`) an await result to an existing variable silently NO-OPED the await**: three await-statement recognizers guarded on `:=` only, so inside a cond/match branch no future was stored and the whole awaiting branch skipped (every call returned the fallthrough — silent wrong values). Found by D5's BufReader bypass test; pre-existing on develop. **FIXED 2026-08-27** (extract_target_variable_id + generate_await_expression + generate_cond_branch_with_await now accept `=`) | **FIXED** — issues/fixed/assign-await-to-existing-variable-silently-noops.md, tests/async_assign_await.test.yo |
| C25 | **a unit-resolving TAIL await emitted `sm->await_result_N;`** — a field the state struct never declares for an effectively-unit result (unit, or the unresolved SomeT a where-bound trait default's `Impl(Future(unit, IoExn))` return looks like), so clang failed with "no member named 'await_result_0'". Found by D5 slice 2's first `write_all` wrapper; the completion-segment substitution lacked the effectively-unit guard the struct allocator and the extraction both had | **FIXED** 2026-08-26 — issues/fixed/unit-tail-await-of-trait-default-reads-missing-await-result.md, tests/async_unit_tail_await.test.yo |
| C27 | **generic impl method with a closure param: `io.async` return type collapses** — fixed-`T` variant awaits to `unit`; `generic(R)` variant types the method call as the CLOSURE's own fn type (future wrapper vanishes). Self-only captures and plain-`R` returns are fine — the trigger is the closure param in the async block's capture, on a generic impl. Blocks async `Mutex.with_lock` (removed from v1, restore on fix) | **OPEN** — issues/generic-impl-async-method-closure-param-return-type-collapse.md |
| C28 | **io.await/io.spawn accepted ANY effect argument** — `io.await(fut_over_IoExn, { io })` / bare `io` type-checked, then codegen memcpy'd sizeof(IoExn) out of the smaller record (`_set_effect` ASan stack-buffer-overflow; THE cause of the red CI test legs + 6 of 8 sweep REDs since 2026-08-25). **FIXED 2026-08-27**: Step-7c layout gate (struct id or exact field-label list — the documented `{ io, exn }` structural form stays legal) + the 8 mis-written test files repaired; pinned by tests/async/effect_bundle.test.yo | **FIXED** — issues/fixed/io-await-effect-arg-not-checked-memcpy-overflow.md |
| C29 | **generic call type variables re-resolve PER ARGUMENT** — `pair_same(generic(A), x : A, y : A)` accepts `(String, i32)`; the signature's mentions of one variable resolve through separate SomeT lineages, so no cross-argument conflict is ever seen (C18's lenient struct compatibility is the second half). Memory-safety face closed by C28's gate; wrong-value faces remain | **OPEN** — issues/generic-type-var-rebinds-per-argument.md |
| C30 | **ctl handler falling through with a unit tail emitted a value-returning C fn with NO return** — the erm C signature renders the unresolved ResumeType (`void*`) while the body path treats unit as statement-tail; exposed by #275's load-bearing `-Werror=return-type` (CI internal shards 2/3: check_watch/module_invalidation batches). Fall-through = implicit RESUME WITH UNIT; codegen now closes every pointer-signature erm with `return (T*){0}` | **FIXED 2026-08-27** — issues/fixed/ctl-handler-unit-tail-missing-c-return.md |
| C31 | **`__yo_init_process_cleanup`'s lazy-init flag raced across worker threads** (TSan data race on `cleanup_initialized`, mislabeled as an RwLock test failure on the TSan CI leg) — every spawned thread runs it via `__yo_gc_init_thread`; Windows already used InitOnceExecuteOnce, POSIX/wasm had a plain static bool. Now an atomic exchange | **FIXED 2026-08-27** — src/codegen/functions/gc_runtime.yo |
| C32 | **`ThreadPool` accepted work no thread can run, then `join_all` deadlocked forever** — on standalone WASI `pthread_create` fails; pool init recorded that (`running = 0`) but `__yo_worker_spawn` ignored it and queued to the dead worker, so `join_all`'s per-worker sentinels never ran and `drained.recv()` blocked with no diagnostic (a CI leg spun **3.4 h** on one test). `Thread.spawn` had the same swallow: null handle, closure never runs, its RC captures never released (the wrapper that drops them IS the thread body), `join` a silent no-op. **FIXED 2026-08-27** — both spawn paths run the task INLINE on the submitting thread when its slot has no OS thread (the wrapper is thread-agnostic; the worker's `__yo_async_wait_all` epilogue is deliberately not run inline, which would re-enter the caller's loop), and `__yo_thread_join` skips a zero handle via a new `__YO_THREAD_HANDLE_IS_NULL` for both platform branches. The WASI skip is REMOVED: `tests/control_fn_as_regular_call` now runs all three tests there, vacuity-probed (a flipped expectation fails on WASI, so the worker body really executes) | **FIXED** — issues/fixed/wasi-thread-pool-submit-deadlock.md |
| C33 | **`HttpError` declares three failures the client cannot produce** — `Timeout`, `TooManyRedirects`, `ResponseTooLarge` were documented and formatted but never constructed. **FIXED 2026-08-28**: `FetchOptions` gained `timeout : Option(Duration)`, `max_redirects` (default 10) and `max_response_bytes` (default 64 MiB, `0` = unlimited) + `with_*` builders; `fetch_with` follows 3xx `Location` (relative and absolute-path resolved against the origin; 303 and POST-301/302 become GET) up to the cap, throws `ResponseTooLarge` before buffering past the ceiling, and races the whole exchange against a spawned `sleep` (awaited `yield`, not the blocking `timeout` combinator) throwing `Timeout`. Six loopback-server tests in tests/http/http.test.yo. Landing it surfaced FIVE compiler/runtime bugs, C36–C40 | **FIXED** — issues/fixed/http-client-error-variants-never-raised.md |
| C34 | **`json_parse` accepted every malformed number, and read ANY garbage as `0`** — `parse_number` scanned characters without validating and always returned `.Ok(atof(span))`, so `1.`/`1e`/`01`/`+1` all passed; and since `_parse_value` routes every unrecognized leading byte there, an empty span made `"hello"` and `"<html>"` parse as the NUMBER 0 (an HTML error page where JSON was expected → `Ok(Number(0))`, not an error; `src/lsp/server.yo` parses every JSON-RPC frame through it). `JsonError.InvalidNumber` was the dead variant that led the audit here. **FIXED 2026-08-27** — RFC 8259 §6 grammar validated before `atof`; 3 tests (2 verified RED first) | **FIXED** — issues/fixed/json-number-parser-accepts-invalid-and-any-garbage.md |
| C35 | **`sizeof(T) * count` was computed UNCHECKED in every collection** — `ArrayList.with_capacity(2^61)` for `u64` wrapped to `malloc(0)`, reported capacity 2^61, and pushed straight outside the allocation (silent heap corruption, no diagnostic); `ensure_total_capacity`'s doubling loop wrapped through zero and SPUN FOREVER; `HashMap`/`HashSet` had the same unchecked multiply behind the `CapacityOverflow` variant that was declared and never produced. `std/allocator`'s `size_would_overflow` shipped exported and called by NOTHING. **FIXED 2026-08-27** — guards at both ArrayList entry points (panic, as Rust's `Vec::with_capacity` does) with an overflow-only clamp so ordinary growth still doubles, `.Err(.CapacityOverflow)` in both hash containers, plus the `>> 32` step both power-of-two roundings were missing; new tests/allocator.test.yo (the helper had zero coverage) + a growth regression guard | **FIXED** — issues/fixed/collection-capacity-overflow-unchecked.md |
| C36 | **Dispatch-mode cond: a sibling arm's SECOND await was neither awaited nor extracted** — its continuation was parked as a `chained_branches` layer with no binding, and both dispatch emitters iterated `cbd.branches` only; `fetch_with`'s http arm read a NULL `stream` (SIGSEGV) against any loopback server — i.e. plain `http://` fetch was broken from #322 (the TLS arm) until now; the CI test only did https. **FIXED 2026-08-28** — `_dispatch_branches` unions chained layers into both switches; `_chain_additional_remaining` carries the depth's own binding | **FIXED** — issues/fixed/async-cond-dispatch-skips-chained-sibling-arm.md |
| C37 | **`io.await` in a plain (non-`io.async`) function is a nested BLOCKING event loop** — called from inside a task it freezes every task below it on the C stack (deadlock the moment the awaited I/O depends on one of them; memory corruption when it resumes a frame mid-step). `_read_http_response` was the only std instance (now an `io.async` future); `JoinHandle.await` and the `std/async` combinators carry the same hazard inside tasks. Wants a RUNTIME diagnostic (`__yo_async_poll_step` re-entered from a task → panic) as its own PR, measured against the suite | **OPEN** — issues/sync-await-in-plain-fn-nests-the-event-loop.md |
| C38 | **A while-with-await inside one arm of a match/cond whose other arm awaits: the state struct never declares `while_loop_N_active`** (the merge takes the first arm's point as representative, which is not in a loop) — clang error, `yo check` green. std keeps the deadline race in its own future (`_fetch_with_deadline`) | **OPEN** — issues/while-await-inside-match-arm-missing-loop-field.md |
| C39 | **An `Exception(throw : (err) -> {…})` handler that assigns a captured `Box` fails inference** (`Got: Type(1)`, error pinned to line 1) | **OPEN** — issues/exception-handler-closure-with-box-capture-fails-inference.md |
| C40 | **A task that re-enqueues itself on every resume (a loop awaiting `yield`) starved the I/O poll** — `__yo_async_run_ready_tasks` drained the queue until empty, so `__yo_io_poll` never ran; `fetch_with`'s deadline race spun forever. **FIXED 2026-08-28** — the drain is bounded to the queue length at entry (the async-`main` loop already capped at 100) | **FIXED** — issues/fixed/async-yield-loop-starves-io-poll.md |

---

## 3. Cross-cutting decisions

### D1 — Error handling: three blessed styles, no fourth

**ADR WRITTEN 2026-08-25** — D1 and D2 are encoded as conventions in
`.github/instructions/yo-design.instructions.md` ("std error handling: three
blessed styles, no fourth" and "std naming conventions"). Enforcement (migrating
violations) rode the S2 sweep.

- **Effects (`exn : Exception` / `IoExn`)** for I/O and anything on the `io` path
  (fs, net, http, process).
- **`Result(T, TypedError)`** for pure fallible transforms: parsing, decoding,
  conversion. Every error type is a real enum implementing `Error()`.
- **`Option(T)`** only for lookups where absence is not an error.

Supporting prelude work still open: `AnyError` downcast (`is(T)`/`as(T)`), a
`derive_rule(Error, …)` so error enums stop hand-writing `ToString` + `Error()`,
and `Error.source` actually used for chaining (`wrap`/`context` helper).

### D2 — Naming conventions (the §5 sweep enforced these)

| Concept | Blessed name | Displaces |
|---|---|---|
| element count | `len()`; `is_empty()` on EVERY container | pub `size` fields |
| map insert | `insert(k, v) -> Option(V)` (old value) | `set` |
| set insert | `insert(v) -> bool` | `add` |
| sequence append | `push` / `push_front` / `push_back` | — |
| membership | `contains` (seq/set), `contains_key` (map) | — |
| value iterator | `into_iter()`; pointer iterator `iter()` | `iter_ptr` |
| accessors | bare noun, no `get_` prefix | `get_flag`, `get_info` |
| byte codecs | `encode` / `decode` | — |
| text formats | `parse` / `stringify` | `decode_html` |
| conversion | `from_` / `to_` / `into_` (Rust discipline) | `to_cstr` vs `to_c_str` |
| comptime twins | `Comptime` prefix on traits, `comptime_` on methods | — |

### D3 — Prelude trait additions (the deepest gap in the whole audit)

All ten items are **DONE** except D3.9 (blocked, below). Landed 2026-08-23 →
2026-08-25 across S1 chunks 1–7 (PRs #240 onward); per-chunk mechanisms are in
the git history and the named issue docs. The record, one line each:

1. **`Default` + `derive(Default)`** — DONE. Derive is structs-only (an enum has
   no canonical default variant); it emits
   `Self(f : (Type.get_struct_fields(Self).get(i).field_type <: Default).default(), …)`
   — field types reached as VALUES by index, no reparseable name needed. En
   route fixed: derive rules fed `Type.to_comptime_string` (a display renderer)
   back into source (issues/fixed/derive-rules-name-types-through-a-display-renderer.md);
   `(T <: Trait).static_method()` bound `Self` to the trait
   (issues/fixed/subtype-dispatch-binds-self-to-the-trait.md).
2. **`From`/`Into`** — DONE. `into(T)` disambiguates by its type argument;
   multiple `From` impls select via explicit `(T <: From(S)).from(v)` — Yo has
   no overloading.
3. **`Ord.cmp -> Ordering`** — DONE, with the decided **no-`PartialOrd` stance**
   (user, 2026-08-23): `cmp` is contractually a TOTAL order; floats use a
   NaN-total order (NaNs equal, greater than +inf; -0 == +0) while `<`/`==`
   operators keep IEEE; float `Hash` DELETED (so `HashMap(f64, …)` is a compile
   error); `PartialOrd` can be ADDED later — the reverse is impossible.
4. **Iterator completion** — DONE (`find`/`position`/`last`/`nth`/`sum`/`min`/
   `max`, `chain`/`take_while`/`skip_while`/`filter_map`/`peekable`, `filter`
   by-value fix, `collect`/`FromIterator`, `rev`/`DoubleEndedIterator`).
   Design points kept: `FromIterator` uses two monomorphic statics
   (`from_iter_new`/`from_iter_add`) with the loop in blanket `collect`; its
   assoc type is `Elem`, NOT `Item` (the assoc-type registry is keyed by
   (type id, label) with no trait discrimination — `Item` would collide with
   the collection's own `IntoIterator.Item`). Still deferred: adaptor
   `next_back` impls (a nominal receiver pattern is not discriminated by its
   where-clause), `HashMap`/`BTreeMap` `FromIterator` (needs unifying an assoc
   type against a CONSTRUCTED pattern), `flat_map`
   (issues/varbound-combinator-receiver-impl-match.md REMAINING). Known limit:
   `.map(f)` chains at two Item types in one module trip
   issues/iterator-chain-shared-stamp-cross-item-pollution.md. (`.rev().rev()`
   was FIXED 2026-08-25 —
   issues/fixed/nested-same-adaptor-instantiation-identity-split.md.)
5. **`Range(T) <: Iterator` + `RangeOp` for all integer types** — DONE.
   Compiler fix en route: operator-built ranges lived in their own type era
   (issues/fixed/range-op-result-era-split-blocks-iteration.md).
6. **`IntoIterator` implemented by every collection** — DONE. Deferred: a
   blanket IntoIterator impl for every Iterator (needs assoc-of-assoc
   `Item := I.Item` in a blanket impl).
7. **Option/Result completion** — DONE (`expect`, `is_some_and`, `inspect`,
   `take`/`replace`, `zip`, `transpose`, `unwrap_or`, `unwrap_or_default`,
   `flatten`, `Ord`/`Hash`/`ToString`).
8. **ToString completion** — DONE (C-interop ints, `longdouble`, containers,
   `unit`). En route fixed: `unit` in C storage positions emitted `void`
   (issues/fixed/unit-typed-params-and-fields-emit-c-void.md,
   issues/fixed/inout-unit-receiver-void-ref-spill.md).
9. **Hasher redesign** — **DECIDED (user, 2026-08-24): full Rust-style `Hasher`
   trait** (`hash(self, hasher : inout(H))`, streaming `write_*`/`finish`,
   pluggable seeded algorithms, derive(Hash) rework, every impl + map driver
   rewritten). **BLOCKED on a prerequisite compiler fix:** the decided trait
   shape — a trait method with its own `generic(H)` and an `inout(self)`
   PRIMITIVE receiver — reads the receiver as a pointer (`(uint64_t)(self)`
   where `(*self)` is meant), silently feeding ADDRESSES to the hasher.
   issues/generic-trait-method-reads-primitive-inout-self-as-pointer.md — third
   site in the `Variable.is_ref` family; attack together with its siblings.
   (Syntax note kept from probing: `inout` goes on the LABEL —
   `inout(hasher) : H`; `hasher : inout(H)` does not parse.)
10. **Format specs** — DONE, stages 1+2 (2026-08-25, PR #259 + follow-up).
    **Separator DECIDED (user): `:`** — `${total:>10.2}`, matching Rust/Python.
    Accepted cost, recorded so it is not rediscovered: `${name:T}` where `T` is
    both a spec letter and a type in scope silently reinterprets (zero
    occurrences today; the backward-walk split rule's closed charset excludes
    `)`/`]`/`}`/quotes/comma/whitespace so it cannot cross out of a call).
    `std/fmt/spec.yo` + `std/fmt/format.yo`; parser lowers `${e:spec}` to
    `e.format("<spec>")`, auto-importing `std/fmt/format` only when a spec
    appears. En route fixed: specialized `inout` param lost its by-ref binding
    on comptime-folded args (#258).

### D4 — String indexing model

**DECIDED (O1, 2026-08-23): byte-indexed, like Rust/Go — and LANDED.** The
migration ran as PRs 0–9 per `plans/STD_API_AUDIT_D4_PLAN.md` (the measured
sub-plan: per-method contracts, call-site counts, trap list). PRs 1–8 all
merged 2026-08-26 (#286, #288, #290, #291). Final state:

- `String.len()` is the BYTE count, O(1). `at`, `substring`, `slice_copy`
  (the `s(a..b)` sugar), `index_of`, `last_index_of`, `contains(from_index)`,
  `starts_with(position)`, `ends_with(end_position)` and the `Pattern` trait's
  five index-carrying methods all take/return BYTE offsets.
- **Boundary policy (the contract, stated on every method):** out-of-range
  CLAMPS; a non-boundary index PANICS in infallible `substring`
  (`try_substring` returns `.None`); `is_char_boundary` /
  `floor_char_boundary` / `ceil_char_boundary` serve callers doing arithmetic;
  search methods never panic (a valid-UTF-8 needle cannot match at a
  continuation byte).
- **Rust-shape amendment (user, 2026-08-26, EXECUTED):** rune work is
  ITERATOR-ONLY — `s.chars().count()` for the rune count,
  `char_indices().nth(n)` + byte `substring` for rune slicing. The
  transitional `char_len()`, `char_substring()`, `truncate_chars()` and the
  `bytes_len()` alias were **DELETED** from `String` and `ImmString` both.
  Rationale: every `len()` in std is O(1) bytes (a freezable law); the
  iterator spelling keeps the O(n) cost visible; Rust has no char-indexed
  slicing either.
- `imm.String` flipped the same way (PR 4) and was **renamed `ImmString`**
  (PR 5, iterators too: `ImmStringChars`/`ImmStringCharIndices`).
- Regex `RegexMatch.index()`/`Regex.search` return BYTE offsets (PR 6; six
  conversion walks deleted — **release-note item**). `std/regex` internals are
  basis-independent (work on `ArrayList(u8)`).
- The comptime string basis matches (PR 7): comptime `len`/`slice`/`s(i)`/
  `s(a..b)` are byte-based; comptime `s(i)` yields the rune STARTING at that
  byte as a 1-rune string (deliberate result-type split vs runtime `u8`); a
  mid-rune offset is a compile error. Seed-safe: zero comptime string
  len/slice/index call sites in `std/`+`src/`+`build.yo`.
- Docs (PR 8): `docs/{en-US,zh-CN}/STRINGS.md` state the byte contract and the
  iterator idiom.
- The flip fixed **ten live mixed-basis bugs** found by the survey (byte
  indexes fed to char APIs — e.g. `mkdir_all`, `Content-Length` as a rune
  count, LSP rename past the end of multibyte identifiers).

**Remaining D4 work:**

- **PR 9** — dedup the remaining hand-rolled UTF-8 decoders onto
  `std/encoding/utf8.yo`, including `vendor/markdown_yo` (needs companion
  upstream commits + a submodule pointer bump). D4 plan §4.
- **LSP UTF-16 position encoding** (§5.4 of the D4 plan) — protocol-visible,
  pre-existing, wants a `positionEncoding` capability; build on the rune⟷byte
  helpers in `src/lsp/protocol.yo`.

### D5 — Async I/O traits + the fd problem

The redesign: async `Reader`/`Writer` traits
(`read(buf, size, io) -> Impl(Future(usize, IoExn))`), implemented by `File`,
`TcpStream`, `BufReader`, `BufWriter`, `Stdin`/`Stdout`; default methods
`read_to_end`, `read_to_string`, `write_all`, `lines()`; `io.copy(r, w)`.
BufReader/BufWriter move from `std/sys/bufio` to `std/io`, wrap any
Reader/Writer (not raw fds), and adopt `IoExn`.

**D5 SLICE 1 LANDED 2026-08-26**: `std/io/index.yo` (the traits, required
methods only — `read`/`write`/`flush`, `*(u8)`+`usize`, `IoExn`),
`std/io/stdio.yo` (`Stdin`/`Stdout`/`Stderr` typed handles over fds 0/1/2 —
kills the `BufReader.new(i32(0))` magic number), `File`/`TcpStream` trait
impls, and the byte-count unification (`File.read`/`write`/`write_string`/
`write_bytes` → `usize`, closing the transient where net returned `usize` but
file/bufio didn't). Tests: `tests/io/async_traits.test.yo`.

**D5 SLICE 2 LANDED 2026-08-26** (unblocked by C24's fixes; C25 was found and
fixed en route — its first `write_all` wrapper did not C-compile):

- `Reader` gained `?=` defaults **`read_to_end`** (chunked loop over the raw
  `read`, no caller pointers) and **`read_to_string`** (a default chained onto
  a default — `Self.read_to_end` then `String.from_utf8`; malformed bytes
  throw the NEW **`IoError.InvalidData`**). `Writer` gained **`write_all`**
  (loops short counts; a 0-byte write throws the NEW **`IoError.WriteZero`**).
  Both variants are Rust's names; `NetError.from_io` has a `_` catch-all so
  the enum growth is safe.
- **`copy(r, w, io) -> Future(u64, IoExn)`** — the free generic, draining any
  `Reader` into any `Writer` via `write_all`; does not flush.
- The INHERENT `File.read_to_string` (and with it the free
  `fs read_to_string` family) now **validates UTF-8** and throws
  `InvalidData`, so the inherent and trait surfaces agree — it had shipped on
  the unchecked `from_bytes`.
- Tests: `tests/io/async_traits.test.yo` 4 → 8 (chunk-looping read_to_end
  through the bound AND as a direct method call, default-onto-default
  read_to_string, copy with byte total, InvalidData throw), vacuity-probed;
  `tests/async_unit_tail_await.test.yo` (C25 red-first).

**D5 GENERIC WRAPPERS LANDED 2026-08-27** (`std/io/bufio.yo`):
`BufReader(R)` — `read_line`/`read_exact`/`buffered` plus a full `Reader`
impl (buffered serve, large-read bypass, refill), so `read_to_end`/
`read_to_string` arrive as trait defaults — and `BufWriter(W)` — batching
`write`, `flush`, and NO dispose-flush (the tokio contract, documented
loudly and pinned by a test: a `Dispose` cannot await the inner writer).
Landing them required fixing C21 (both layers) and C26, both found by this
work. `tests/io/bufio.test.yo` (11) carries the `tests/sys/bufio.test.yo`
coverage re-expressed generically plus the new contracts.

**D5 BUFIO MOVE COMPLETED 2026-08-28** — the seed gate lifted with v0.2.18
(which carries #299's shadow-registration fix, verified by building this tree
with the actual v0.2.18 bundle before touching anything). The compiler's three
consumers — `src/lsp/transport.yo`, `src/lsp/server.yo`, `src/check_watch.yo` —
read stdin through `BufReader(Stdin)`, shedding the fd API's `Result` wrapper for
the generic one's `IoExn` throw, and **`std/sys/bufio` + its 25-test file are
DELETED**. `BufWriter(W)` regained `write_string`/`write_bytes` in the process:
the deleted writer had them, the generic one had only the pointer-taking trait
primitive, and losing them would have made "write a String to a buffered writer"
a pointer exercise (2 tests; tests/io/bufio.test.yo 11 → 13). Gates: the
v0.2.18 seed builds the migrated tree (rc=0), and the `lsp-handshake`,
`lsp-completion` and `check-watch-once` goldens — which ARE the migrated stdin
path — pass unchanged.

**D5 remaining:** **C17** blocks the `Dyn(Reader)` spelling. (c) a buffered `lines()` waits on an async iterator
protocol (deliberately not faked). Inherent-vs-trait NAME duplication (`File.read_bytes` vs the trait's
`read_to_end`, the inherent `read_to_string`) is a D2 question to settle when
the wrappers land. Cautions that still stand: **C21**
(`-Wincompatible-pointer-types` across implementors — the two warnings are
live in the slice-2 emit), **C22** (no nested closures inside `io.async`
bodies), and the C12 note (BufWriter's SYNC `Dispose` flush cannot await an
async `Writer.write`).

### D6 — TLS position

No TLS in tree; C1 makes https throw for now. **DECIDED (O2, 2026-08-23):
`std/crypto/tls.yo` over platform libraries (SecureTransport/Schannel/OpenSSL)
via the existing `pkg_config` mechanism, behind one `TlsStream` type
implementing the D5 traits.** **PR-1 LANDED 2026-08-28**: `TlsStream` over
OpenSSL (memory-BIO async pump, cert+hostname+SNI on, D5 Reader/Writer),
proven by a live example.com:443 handshake; `_probe_openssl` in src/main.yo
(plans/D6_TLS_PLAN.md). Remaining: route `std/http` https through it (PR-2)
and the P0+ curl→std/http swap (PR-3, the only D6 remainder); Windows
Schannel joins the Windows platform audit.
**PR-2 LANDED 2026-08-28**: `std/http` fetch routes https through
`TlsStream` — a scheme branch chooses TcpStream|TlsStream transport, the
response reader is shared as a generic over the D5 `Reader` trait, port
defaults to 443; a live `https://example.com` fetch returns 200 (pinned,
guarded to skip offline).

### D7 — sync/concurrency shape

Landed 2026-08-25/26 (PR #287 and siblings). Records, one line each; open
items follow.

- **`RwLock(T)` with `with_read`/`with_write`** — DONE. Owns the value;
  release via `Dispose` of private unlocker objects (the `__MutexUnlocker`
  mechanism), raw lock methods internal. `with_write` takes
  `Impl(Fn(inout(v) : T) -> R)`, `with_read` by-value — the only read/write
  distinction Yo's parameter modes can express.
- **Parallel C-tier (`mutex_t`, `cond_t`) deleted** — DONE (§6 round 2); no
  `RawMutex` was needed (`Cond.wait` already took `*(__YO_THREAD_SYNC_TYPE)`).
  `__YO_THREAD_SYNC_TYPE` cannot be unexported — the compiler itself consumes it.
- **Atomics** — DONE. All seven `fetch_*` ops on all 10 integer atomic types
  (`AtomicBool` deliberately none), `fence(order)`; receiver unified on
  `self : Self` (an atomic IS a shared handle; 46 receivers rewritten).
  Lowering: `AtomicI32` keeps the native C11 `atomic_fetch_*` macros (the one
  Yo binding the `_Generic` macro can have); everything else runs a
  compare-exchange loop — same semantics, verified wrapping. Native
  `__yo_atomic_fetch_*` runtime wrappers are **seed-gated**
  (`plans/backlog/SEED_VERSION_AUTOMATION.md`).
- **`OnceCell(T)`** — DONE, as a SEPARATE type in `std/sync/once.yo`, not a
  generic `Once` (value-less `Once.call` users are legitimate; Rust draws the
  same `Once` vs `OnceLock` line). `get_or_init`/`get`/`is_initialized`,
  double-checked locking over `Once`.
- **`std/worker` → `ThreadPool` in `std/thread`** — DONE, with three
  deviations each forced by a measured compiler bug (reproducers under
  `issues/repros/`): `spawn(pool, cb)` is a MODULE-LEVEL function
  (issues/impl-method-self-receiver-hollows-forwarded-spawn-closures.md);
  `spawn` returns `unit` and `join_all` is a sentinel-task BARRIER, not a
  completion counter (issues/spawn-wrapper-forwarded-io-crosses-specializations.md);
  `shutdown` drains this pool but cannot stop the process-global OS workers.
  Known leak, filed not worked around: ~344 B per `join_all`
  (issues/spawn-closure-captures-never-dropped-leak.md — spawn emitter never
  drops closure captures; pre-existing).
- **`Semaphore` + `Barrier`** — DONE 2026-08-26 (`std/sync/semaphore.yo`,
  `std/sync/barrier.yo`; counting P/V model, reusable generation model). Both
  on `Mutex` + `Cond`, state under the mutex.

Open D7 items:

- **`Thread.spawn` result carry (`join() -> T`) + panic propagation — BLOCKED
  below std.** `join() -> T` needs spawn-closure re-specialization
  (issues/spawn-closure-generic-captures-erased-to-void-ptr.md). Panic
  propagation is not implementable at any layer today: `panic` lowers to
  `fprintf` + `abort()`, no unwinding runtime, no per-thread recovery point.
  Do NOT accept a `join() -> Result(T, E)` signature that cannot actually
  observe a panic.
- **`WaitGroup` deletion** — waits on a per-consumer MIGRATION DECISION:
  `ThreadPool.join_all` is a whole-pool barrier while all five consumers use
  `WaitGroup` for per-task waiting inside a shared pool, so neither `join_all`
  nor `Semaphore`/`Barrier` is a drop-in. Decide per consumer
  (`tests/imm_threading`, `tests/sync/{channel,once,rwlock,waitgroup}`),
  record here, then delete.
- ~~**Async-aware sync is a P0 addition** (§7): async `Channel`, async `Mutex`,
  `select`/timeout~~ **DONE 2026-08-27** — §7 P0 item 6 (`std/async/channel`,
  `std/async/mutex`, `race`/`any`/`timeout` in `std/async`; `select` is
  covered by `race` over handles).

### D8 — module layout

- ~~`std/os/env.yo` merges into `std/env.yo`; flatten `std/os/`~~ **ROW WAS
  STALE (measured 2026-08-27): `std/os/` does not exist** — the merge
  happened before this audit's execution reached it, and `fs/temp` already
  uses the merged `temp_dir()`. The one live grain: `temp_dir()` ignored
  `TMPDIR` on POSIX — fixed 2026-08-27 (`$TMPDIR` else `/tmp`).
- **`std/encoding/utf8.yo` — DONE 2026-08-25** (#286). One shared UTF-8
  module (15 exported names), every private copy in `std/` routed through it
  (eleven files carried bit-twiddling, not the row's six — three were
  encoders). Design points worth not re-litigating:
  - Strict + lossy entry points per direction (`decode` returns
    `Result(Decoded, Utf8Error)`; `decode_lossy` substitutes U+FFFD and always
    advances; `encode_lossy_into` takes raw `u32` so nothing in std can emit
    CESU-8 by accident).
  - `decode_parts(b0..b3, available, index)` is the public core —
    `ImmString`'s raw `*(u8)` decodes without allocating.
  - **`Utf8Error` has NO `ToString`/`Error()` impl, by construction** — those
    traits live above this module and importing them would close a cycle
    through the core of std. Inherent `message()`/`index()` instead;
    `StringError.InvalidUtf8(cause : Utf8Error)` is how detail reaches a
    throwable. **Load-bearing**: `std/string/string.yo` must be able to import
    this module.
  - ASCII fast paths in `decode`/`validate_range` are load-bearing (the
    compiler's own lexer runs through them). RFC 3629 strict validation.
  - Three latent bugs fell out: regex read past a truncated tail; utf16 let an
    unpaired LOW surrogate through as CESU-8; `base64_decode_string` returned
    non-UTF-8 `String`s. All fixed red-first. Filed, NOT fixed:
    issues/unicode-case-conversion-ignores-locale-so-non-ascii-is-unchanged.md
    (the real content of the string row's "Unicode-correct `to_lowercase`").
- **`String.from_bytes` correction (2026-08-25):** it did NOT become
  validating. What landed: `String.from_utf8(bytes) -> Result(Self, StringError)`
  (the validating constructor) + `from_bytes` documented as the UNCHECKED one.
  The rename `from_bytes` → `from_bytes_unchecked` is **vendor-gated**: ~170
  call sites including 26 in `vendor/markdown_yo` — do it in one commit with
  the vendor bump. **`String.from_cstr` must NOT start validating**: 22 call
  sites in `std/fmt/to_string.yo` make it the hottest string path in the tree
  (every `${x}` — the bytes are snprintf output). One behaviour change
  measured: `${rune}` for NUL and hand-built surrogates (both previously
  broken outputs; no std behaviour moved).
- ~~`EncodingError` moves out of `hex.yo` into `std/encoding/error.yo`~~ **ROW WAS STALE (measured 2026-08-27)** — it already lives in `std/encoding/error.yo`, imported by hex and base64.
- **Regex internals private + typed `RegexError` — DONE 2026-08-25.** Findings
  against the row: "go private" has no language mechanism (Yo's only
  visibility control is `export(...)` and siblings must import each other) —
  export lists trimmed to actual consumers, `//!` not-public headers added,
  the package surface cut to `Regex, RegexMatch, RegexError`; `MAX_SLOTS` was
  DEAD, not undocumented (deleted; a 120-group pattern works, pinned by test);
  `RegexError` is a closed 14-variant enum with `ToString`+`Error()`, no
  `Other(msg)` escape hatch. Filed en route:
  issues/template-string-backslash-before-interpolation-eats-both.md.
- ~~**OPEN:** `std/glob` stays the matcher; `fs.walker` gains `pattern` option +
  a `glob(pattern, io)` expansion function (the Python/Node meaning).~~
  **DONE 2026-08-28** (`WalkOptions.pattern` filters root-relative paths via
  glob_match — dirs still descended so `**` finds deep files; `glob(pattern,
  io)` walks from the pattern's static prefix. En route surfaced an OPEN
  codegen hazard: a match/return tail after an awaiting loop hangs the state
  machine — issues/async-tail-match-return-hangs-state-machine.md; the filter
  lives in a sync helper instead).

---

## 4. Per-module verdicts

| Module | Verdict | Notes |
|---|---|---|
| prelude | FIX + EXTEND | D3 traits DONE; C6 impl removals DONE; `if` macro deletion is seed-gated (next seed bump) |
| error/assert | EXTEND | downcast, derive(Error), context; narrow `error.yo`'s blanket `open(import(./string|./fmt))` re-export |
| fmt | FIX + EXTEND | `display.yo` deleted (§6); format specs DONE (D3.10); still: collapse 4 print bodies; dedupe 15 snprintf helpers |
| spec/ | FREEZE AS DOC | identity stubs; mark experimental, exclude from stability promise |
| collections/* | RENAME + EXTEND | §5 renames DONE; ~~`retain/extend`, `binary_search`, real `sort` (not O(n²) insertion), `sort_by`~~ **DONE 2026-08-28** (in-place heapsort shared by sort/sort_by, Ok/Err-insertion-point binary_search, order-preserving RC-correct retain, copying extend); ~~entry API~~ **DONE 2026-08-28** (PR #316: `get_or_insert`/`get_or_insert_with`/`update_with` — Yo-shaped, no borrow object); still: `drain`; HashSet = HashMap(T, unit) to kill ~500 duplicated SwissTable lines; hide pub `ctrl/data/…` fields; `BTreeMap` → real B-tree with `range()` (recommend: real B-tree, keep name); add `BTreeSet`; `PriorityQueue`: comparator ctor, DOCUMENT min-heap |
| imm/* | KEEP (O4) + FIX | stays in std; `Acyclic` element bounds LANDED (O7, 2026-08-27); still: iteration + `Index` where doc'd, dedupe set pair, mark unstable until exercised |
| string | FIX + EXTEND | D4 byte-indexing DONE (both types); still: Unicode-correct `to_lowercase` (+ `to_ascii_*`; see the locale issue), `Pattern` impl for `rune` + `Regex`, `replace*` Pattern-generic, `parse_f64`/radix, `split_once`, `strip_prefix/suffix`, move `panic_dyn`/`assert_dyn` to assert, delete one of `to_cstr`/`to_c_str`; `StringError` is live now (from_utf8) |
| encoding | STANDARDIZE | utf8, percent, `html_encode` + the `html_decode` rename DONE; still: one error style per D1 (base64's `Result(_, String)`), base32, CSV (P1), toml floats/arrays/dates/serializer + derives (P1) |
| json | EXTEND | enum representation DECIDED externally-tagged (O3); `JsonValue.Object` O(n) parallel arrays → keep repr, add index map if profiling demands |
| regex | POLISH | typed error + private internals DONE (D8); byte `index()` DONE (D4 PR 6); still: `Regex.escape`, optional-flags `new`, callback replace, lazy `find_iter`, group byte-spans |
| url | EXTEND | percent-encode/decode integration, `query_pairs`/`SearchParams`, `join` (RFC 3986 §5 — needed by http redirects), builder/setters; punycode DELETED (§6) |
| io | REDESIGN | D5 — slices 1–2 DONE; generic wrappers + bufio move remain |
| fs | EXTEND + POLISH | wrappers: `copy`, `remove_dir_all` (compiler implements it TWICE as workaround — `src/fetch.yo:80`, `src/version_cache.yo:72`), `read_link`, `set_permissions`, `set_len`, `try_exists`, `watch` (sys/events exists); `OpenOptions` builder; `File.from_fd`; Metadata: real `btime`, `permissions()`, stop `metadata` re-stat by path; DirEntry `path()`; walker: lazy option + glob filter; collapse the `_str`/`_cstr` matrix with an `AsPath` trait |
| path | FIX + EXTEND | `join(str)`, `push`, `Hash`/`Ord`/`Clone`, Windows separator in `to_string`, `ancestors`, PATH split/join; revisit eager `..` normalization (symlink semantics); `PathError` deleted (§6) — or make `new` fallible |
| env | MERGE (D8) | + `remove`, `vars()` iteration, `str` keys |
| process | EXTEND | Child/spawn/Stdio + env + builders-return-Self + `code() -> Option(i32)` DONE 2026-08-27; still: `current_dir` (seed-gated runtime shim), hide `raw` (needs module-private visibility) |
| cli | EXTEND or DROP-TO-PACKAGE | typed values, required enforcement, `--`, repeated opts, help-not-an-error; needs tty/color access (D8 wrappers). Recommendation: keep minimal-but-correct in std |
| net | FIX + EXTEND | C2/C3 DONE; `Shutdown` enum DONE; usize counts DONE; UnixStream/UnixListener DONE 2026-08-27 (incl. their Reader/Writer impls); still: `incoming()`, UDP `connect` + typed `recv_from`, `parse_v6`, `SocketAddr.parse`, `Eq`/`Hash` on addr types, RFC 5952 V6 formatting |
| http | FIX + EXTEND | C1 DONE; ~~https over TLS~~ **DONE 2026-08-28** (D6 PR-2: scheme branch, shared generic Reader response loop, TcpStream|TlsStream transport, default port 443); still: timeouts (dead `Timeout` variant becomes real), redirects (needs `Url.join`), chunked decoding, binary bodies, keep-alive; **server (P1)**: `parse_request`, `HttpServer` on `TcpListener`; collapse `FetchOptions` into `HttpRequest` |
| async | PROMOTE | combinator home: `join_all`, `race`, `any`, `timeout`, interval, cancellation for `JoinHandle` (`abort()`), async channel/mutex (D7). `sleep(Duration, io)` lives in `std/time/sleep.yo` — do NOT add a second one; re-export if wanted |
| thread/worker/sync | REDESIGN (D7) | ThreadPool DONE; `join() -> T` + panic propagation blocked below std — see D7 |
| time | EXTEND | ~~`Duration`: `Add/Sub` operators, `Eq/Ord/Hash`, `from_secs_f64`, `subsec_*`, consts~~ + ~~`Instant` `add/sub`, `Eq/Ord`~~ **DONE 2026-08-28** (PR #312: operators mirror add/sub incl. zero-saturation, total-nanos Hash, from_secs_f64 clamps negatives, SECOND…HOUR consts, Instant.sub clamps at clock zero); **make std USE it** (timeouts, sleeps); ~~`DateTime`: RFC3339 `parse`/`format`, component ctor, arithmetic, `Eq/Ord`~~ **DONE 2026-08-28** (leap-aware `parse` incl. lowercase t/z + space separator + nano fractions + numeric offsets, typed `DateTimeError`, validating `new`, `add`/`sub(Duration)` offset-preserving, INSTANT-basis `Eq`/`Ord` + `to_unix_utc`; `to_string` was already RFC3339 — round-trip pinned); sleep unification DONE (§5) |
| crypto | EXTEND | `Digest` trait + SHA-1 + SHA-512 + streaming Md5 + HMAC + CRC32 + `constant_time_eq` DONE 2026-08-27; `std/rand` DONE 2026-08-27 (PCG32) |
| log | REWRITE (zero users = free window) | ~~levels + `Off`, `ToString`-generic message, lazy eval, timestamps, target/module, thread-safe; keep the free-function facade~~ **DONE 2026-08-28** (PR #319: Off + Eq(Level) + get_level; generic ToString messages; `*_target`; `*_lazy` `()->String` closures gated before call; `set_timestamps` RFC3339; one mutex over filter+write). Deferred: a pluggable WRITER SINK beyond stdout/stderr (needs a Writer-trait object stored in module state) |
| testing | EXTEND | ~~`assert_eq`/`assert_ne`/`assert_approx` (diff-printing)~~ **DONE 2026-08-28** (std/assert: both-sides / shared-value / |diff|-vs-epsilon panics; optional msg; `Eq(A)+ToString` bounds; tests/assert_eq.test.yo); `bench`: auto-calibration, black_box, stddev/percentiles |
| gc/allocator | POLISH | `gc.stats()`; `CustomAllocator` deleted (O6) |
| build | KEEP (already coherent) | Zig-shaped, comptime-correct; only additive evolution |

---

## 5. The rename/breaking sweep

**Versioning decision (user, 2026-08-24): no minor release** — breaking std
changes ship in ordinary v0.2.x patch releases.

**The sweep is DONE** (S2 chunks 1–4 + the sleep unification, 2026-08-25).
One-line records; decisions embedded in them stay binding:

- Map/set `set`/`add` → `insert` (incl. `TomlTable`). NOT renamed, correctly:
  `env.set` (setenv), `imm.Vec.set` (index replacement — a different concept).
- `ArrayList.is_empty` added (the only container missing it).
- `HashMap.iter_ptr` → `iter`.
- Value-typed `?(T)` → `Option(T)` (10 sites). The 130 `?(*(…))` nullable
  raw-pointer uses at the C boundary are an idiom, not an inconsistency — KEPT.
- `BTreeMap min/max` → `first_entry`/`last_entry` (returns a whole entry);
  sets keep `min`/`max` (return the element).
- `Bucket`/`BTreeEntry`/`OrderedMapEntry`/`Pair` → one `MapEntry(K,V)` in new
  `std/collections/entry.yo` (NOT in the prelude — measured self-emit memory
  cost, issues/std-s1-prelude-growth-tripled-self-emit-memory.md). Prelude
  `IterPair(A, B)` is POSITIONAL, not a map entry — left alone.
- `canonical` family → `canonicalize`; `relative_from` → `strip_prefix`;
  `created_time` → `status_changed_time` (it returns ctime; a real btime is a
  FEATURE, still open — needs `STATX_BTIME`/`st_birthtime`/CreationTime).
- fs free functions → **symmetric pairs** (user, 2026-08-25): `read`/`write`
  (bytes), `read_to_string`/`write_string` (String) — matching `std::fs`.
  Collision-checked: a glob `open(import("../fmt"))` resolves to the package
  ENTRY POINT's exports only (7 names), so D5's io `Writer` cannot clash with
  `fmt.Writer` in the three glob-importing files.
- `TcpStream.shutdown(i32)` → `shutdown(Shutdown)` enum; net byte counts →
  `usize` (8 methods; also sharpened http's EOF test from `n <= 0` to
  `n == usize(0)`).
- punycode renames OBSOLETE — module deleted (§6).
- Two `sleep`s → `std/time/sleep.yo`: `sleep(Duration, io)` async +
  `sleep_blocking(Duration)`. `std/sys/timer` keeps raw ms (syscall boundary).
  En route fixed: inline-builtin alias dropped body arguments
  (issues/fixed/inline-builtin-alias-drops-body-arguments.md);
  `sleep_blocking`'s two-statement body is a SEED GATE
  (`plans/backlog/SEED_VERSION_AUTOMATION.md`). Deferred: migrating
  `src/check_watch.yo` off `std/sys/timer`.

**Still open in §5:**

- `ArrayList`: `remove(start,count)` → `drain(range)`, single
  `remove(idx) -> T`, `iter()` pointer iterator — needs compiler-as-oracle
  treatment (name shared with map/set `remove`) and changes a return type.
- `Http` inherent `to_string` → `ToString` impl.
- `str.join(items)` receiver-as-separator: KEEP (Python style) but document;
  `index_of`/`last_index_of` KEEP (JS names are the local norm).

**The method lesson every chunk inherited** (full version in the handover §5):
`yo check` + `yo build` were ALL GREEN while the tree was broken — four call-site
classes are structurally invisible to check (macro `quote` bodies, generic
trait-impl bodies, generic helpers in the defining module, async closure
bodies — the last becomes a silent `// Failed to transpile` stub,
issues/ftt-stub-in-live-closure-falls-off-non-void-function.md). The gate for a
rename chunk is the FULL suite plus a READ golden diff, and grep inside
`quote(`, `impl(` and `io.async(` bodies by hand.

## 6. Deletions (all pre-stability; each verified zero/near-zero usage by grep)

**DONE — deleted across rounds 1–2 (2026-08-25):** `std/alg/hash.yo` (and
`std/alg/` itself), `std/encoding/punycode.yo`, `std/fmt/display.yo`,
`std/collections/list_view.yo` (+ test), `mutex_t`/`cond_t`,
`std/io/{reader,writer}.yo` (their trait decls moved into
`tests/io/reader_writer.test.yo` — the only coverage of a `*(u8)`+`Exception`
user trait; `std/io/` freed for D5), `std/env.yo`'s `raw_args`/`argv`/`argc`,
prelude `export();` no-op + commented-out `c_macro` block, `PathError`,
`CustomAllocator` + `Allocator :: Dyn(CustomAllocator)` (O6),
`AllocError.{InvalidSize,InvalidAlignment,InvalidPointer}`,
`ExprInfo.popped_env_frame` (PR #283 — compiler struct change, took the full
battery). Export hygiene: `__MutexUnlocker`, `ArgKind`/`ArgDef` unexported.

**KEPT / BLOCKED — each with the measurement that blocks it:**

- **`WaitGroup` — KEEP** until the per-consumer migration decision (D7): five
  test files use it for per-task waiting, which `join_all` (whole-pool
  barrier) does not cover.
- **`std/collections/linked_list.yo` — KEEP**: load-bearing half of the #249
  regression trigger (`tests/where_clause_fn_inference.test.yo`'s minimal
  era-copy/GC-trace reproducer). Revisit if that test is re-expressed.
- **`base64_{encode,decode}_string` — NEEDS-DECISION**: `encode_string` is a
  pure duplicate, but `decode_string` also strips whitespace and returns
  `Result` — "fold in" is a behaviour decision about `base64_decode`, and
  deleting only the encode half would be asymmetric.
- **`HashMapError`/`HashSetError` dead-variant trim — BLOCKED by a compiler
  bug**: removing them makes the two enums structurally identical, which
  collides (`issues/structurally-identical-error-enums-in-two-generic-impls-collide.md`,
  repro `issues/repros/hashmap-hashset-error-enums-collide.yo`). Fix the
  compiler first. (`HttpError.Timeout` etc. become REAL when the features
  land — implement, don't delete.)
- **`StringError` — WIRED UP, not deleted** (2026-08-25 correction): it was
  "never constructed" because `from_cstr` never validates. `from_utf8`
  constructs `InvalidUtf8(cause : Utf8Error)` now; `IndexOutOfBounds` is the
  natural error for D4 bounds failures. The from_bytes rename is vendor-gated
  (D8 note).
- **Regex internals / fs-types converters / html_entities builders** — need
  either module-private visibility (Yo has none) or an internal-but-shared
  rename; a sweep cannot do it. `std/libc/*` underscore names are REAL C
  symbols and must keep them (~90 of ~101 underscore exports).
- **Follow-up:** `__yo_c_macro_defined`/`__yo_c_macro_value`
  (`std/prelude.yo`) are dead externs — no evaluator handler exists; deleting
  them needs its own verification that an unresolved prelude extern is not
  load-bearing.

**Method note:** a passing targeted test can be VACUOUS here — the enum
collision was caught only by a standalone compile+RUN of a program importing
both modules. Gate std deletions on a program that exercises the changed
declarations at runtime.

## 7. Additions ranked (post-sweep, additive, batteries-included)

**P0 — unblock real programs**
1. ~~`std/encoding/percent.yo` (percent-encode/decode)~~ **DONE 2026-08-27** (RFC 3986 component codec: `percent_encode`, `percent_decode` (UTF-8-validated) + `percent_decode_bytes`, typed `PercentError` with byte indexes; `+` deliberately NOT a space — the form dialect can be added additively). URL/query integration still open (rides the `Url` extension work)
2. ~~`std/encoding/utf8.yo` (D8)~~ **DONE 2026-08-25**; ~~`html_encode`~~ **DONE 2026-08-27** (the five XSS-critical characters; `html_decode(html_encode(s)) == s` pinned) — the D2 rename `decode_html` → `html_decode` landed with it
3. `std/io` redesign with stdio handles (D5) — slices 1–2 DONE; generic wrappers + bufio move remain
4. ~~`fs.copy`, `fs.remove_dir_all`, `read_link`, `set_permissions`, `try_exists`~~ **DONE 2026-08-27** — `copy` (contents + permission bits + byte count), `try_exists` (throws instead of lying `false` on a denied parent), `set_permissions` in `std/fs/file`; `read_link` in `std/fs/dir`; `remove_dir_all` in **`std/fs/walker`** (its implementation IS the walker, and `fs/walker` imports `fs/dir` — the reverse would cycle); `src/fetch` + `src/version_cache` dropped their private copies. En route: the libc `chmod`/`fchmod` bindings declared their mode as the OPAQUE `mode_t : Type`, which no Yo caller can construct (`mode_t(384)` is a SomeT-callee error — silently swallowed in async bodies); rebound as `u32`
5. ~~`process.Child`/`spawn`/`Stdio`~~ **DONE 2026-08-27** (`Stdio` Inherit/Piped/Null; chainable builders returning `Self` incl. `env`/`env_clear` over a real envp built from `environ` + overrides; `spawn() -> Child` with `pid`/`write_stdin`/`close_stdin`/`read_std{out,err}_to_end`/`kill`/`wait`; parent pipe ends CLOEXEC — without it a child held the parent's stdin write end and never saw EOF; `ExitStatus.code()` is now `Option(i32)` — a signal death is `.None`, 13 consumers swept). `current_dir` DEFERRED: needs `posix_spawn_file_actions_addchdir` in the runtime shim — a new extern, i.e. SEED-GATED (plans/backlog/SEED_VERSION_AUTOMATION.md). **POSIX-only for now**: the Child/spawn plumbing and the item-4 fs wrappers have no Windows story (fs_convenience's S3 section hard-crashed the Windows CI child; sections skip on Windows) — issues/s3-fs-wrappers-windows-semantics-audit.md
6. ~~async combinators + async channel/mutex + `timeout` (D7)~~ **DONE
   2026-08-27** (branch `s3/async-combinators`, merge pending the CI-red
   triage). Delivered: **JoinHandle `state()`/`is_finished()`/`abort()`**
   (prelude + two C runtime helpers over the spawned-future common header + a
   resume-entry guard so an externally-aborted, suspended task's pending
   completion releases the state machine instead of falling through the state
   switch); **`std/async` → directory** — `index.yo` keeps `yield` and adds
   the blocking-poll combinators `join_all`/`race`/`any`/`timeout` (they
   drive the loop via `__yo_async_poll_step`, exact deadlines — `timeout`'s
   deadline is a spawned TASK, not a bare `IoFuture` local, see
   issues/pending-io-future-local-drop-uaf.md); **`std/async/channel`**
   (bounded FIFO `Channel(T)`: suspending `send`/`recv` + `try_*`/`close`,
   1ms-tick waits, same-thread by design); **`std/async/mutex`** (`Mutex(T)`:
   suspending `lock`, `try_lock`/`unlock`/`get`/`set`; `with_lock` PARKED on
   C27). 19 tests in tests/async/. En route fixed
   issues/fixed/io-future-named-local-declared-by-value.md; en route found
   C27 + the io-future drop-ownership hole (both filed)
7. ~~`crypto`: HMAC, SHA-1, SHA-512, CRC32, `Digest` trait~~ **DONE 2026-08-27** (streaming `Sha1`/`Sha512`/`Md5` on the Sha256 skeleton; the `Digest` trait — `new`/`update`/`digest_size`/`block_size`/`finish_bytes` + a `finish_hex` `?=` default — implemented by all four; generic `hmac` via `(D <: Digest)` statics + `hmac_sha{1,256,512}(_hex)` + `constant_time_eq`; bitwise reflected `crc32`; all pinned to FIPS 180-4 / RFC 2202 / RFC 4231 / CRC-catalog vectors). `std/rand` **DONE 2026-08-27** (seedable PCG-XSH-RR 64/32 `Rng`: `new`/`with_stream`/`next_u32`/`next_u64`/`next_f64`/rejection-sampled `next_below`+`range`/Fisher–Yates `shuffle`/`choice`, pinned to the pcg-random.org reference sequence — landing it surfaced and fixed the 6-digit float-literal truncation, issues/fixed/float-literals-normalized-through-6-digit-percent-g.md)
8. ~~prelude D3 items 1–8~~ **DONE** (D3.9 Hasher blocked, D3.10 done)
9. `Duration` integration everywhere a timeout/interval appears — **SURVEYED
   2026-08-27, all but one surface already done**: `std/time/sleep` +
   `sleep_blocking` and `std/async`'s `timeout` take `Duration`;
   `std/sys/timer.sleep(milliseconds : u64)` and its extern stay raw BY DESIGN
   (the sys layer mirrors the syscall). The last `Duration` surface, the HTTP
   client, gained `FetchOptions.with_timeout` with **C33** (2026-08-28,
   issues/fixed/http-client-error-variants-never-raised.md) alongside the two
   other formerly never-raised `HttpError` variants
10. ~~`net.UnixStream`/`UnixListener`~~ **DONE 2026-08-27** (`std/net/unix.yo` mirroring the Tcp pair one-to-one — bind/accept/connect/read/write family + `Reader`/`Writer` impls; the socket FILE is not unlinked on close, like Rust; echo round-trip + AddressInUse pinned)

**P0+ — user-requested (2026-08-23), tracked with this campaign**
- ~~`yo <subcommand> --help`~~ **DONE** (verified 2026-08-25;
  `_subcommand_help_text` in `src/main.yo`, local, before version pre-dispatch,
  stops at `--`).
- Replace the two `curl` shell-outs (`src/version_cache.yo` — bundle download
  + releases list) with `std/http`. **Blocked on TLS (D6/O2)** — doing it
  earlier would silently downgrade the toolchain's release channel to
  cleartext.

**P1 — expected of a modern std**
HTTP server + chunked/redirect/timeout client; TLS (D6); CSV; DateTime
parse/format; `fs.watch`; testing `assert_eq` family; log rewrite; glob
expansion; ~~`Semaphore`/`Barrier`~~ **DONE 2026-08-26**; ~~`ThreadPool`~~
**DONE 2026-08-26**; ~~format specs~~ **DONE**; entry API + `binary_search` +
real sort; tty/terminal-size wrappers (cli needs them)

**P2 — nice-to-have / decide-later**
WebSocket; YAML/XML (lean package-ecosystem); msgpack/CBOR; base58;
`BTreeSet`+range queries (with the real B-tree); bitset; `SmallVec`; LRU cache;
mmap/file-lock/statfs wrappers; `gc.stats`; DNS SRV/TXT/reverse

## 8. Open questions — ALL DECIDED (user, 2026-08-23)

- **O1 (D4)**: **byte-indexed, matching Rust — EXECUTED** (all nine PRs but
  the decoder dedup; final state and the Rust-shape amendment are in §3 D4).
- **O2 (D6)**: **platform TLS libraries via `pkg_config`**
  (SecureTransport/Schannel/OpenSSL), behind one `TlsStream` implementing the
  D5 traits. Until it lands, https throws `UnsupportedScheme` (C1).
- **O3**: **externally tagged** `{"Variant": {...}}` (serde default).
- **O4**: **keep `imm/` in std for now.** Fix bugs, mark unstable until it has
  real consumers; revisit promotion at stability time.
- **O5**: **single `ToString`.** No `Debug`/`Display` split; derive output
  routed through a `Formatter` so pretty/compact can be added additively.
- **O6**: **delete `CustomAllocator`** — **DONE 2026-08-25.** Yo objects are
  reference-counted, so a per-collection allocator parameter would flow
  through every RC header alloc/free — the Zig model doesn't fit. If per-heap
  control is ever needed: a process-global runtime hook (Rust
  `#[global_allocator]` model, the mechanism `--allocator system|mimalloc`
  already proves out), not a type parameter.
- **O7**: **require `Acyclic` on imm element types, like `Arc`.** Atomic RC is
  only sound for acyclic data; `atomic(...)` of a non-`Acyclic` type is a BUG.
  **LANDED 2026-08-27**: every element/key/value bound across the imm family
  (`List`/`Vec`/`Set`/`Map`/`SortedSet`/`SortedMap`, ~80 where-sites) now
  requires `Acyclic` alongside `Send`; the public wrappers and `ImmString`
  carry `Acyclic` impls so containers nest; module docs state the contract
  instead of warning about the leak. Enforcement verified BOTH ways:
  structurally-acyclic types derive the trait automatically (zero existing
  consumers broke — all 212 imm tests pass unchanged), and a
  SELF-REFERENTIAL element fails instantiation with "does not implement
  required trait Acyclic" (pinned by a `comptime_expect_error` test in
  `tests/imm_vec.test.yo`). **Audit residual, needs a decision:** the
  `std/sync` atomic containers (`Channel(T)`/`Mutex(T)`/`RwLock(T)`/
  `OnceCell(T)`) are still `Send`-only — the same hazard class (a cyclic
  ATOMIC payload, e.g. `atomic(ref(struct(next : Option(Self))))`, leaks
  through them). Requiring `Acyclic` there is a further breaking change to
  decide separately.

## 9. Phasing

1. **S0 — correctness:** §2 — **DONE** (open compiler rows tracked in §2).
2. **S1 — conventions ADR + prelude traits (D1–D3):** **DONE** (D3.9 blocked).
3. **S2 — the breaking sweep (§5 + §6 + D4/D5/D7/D8):** **DONE 2026-08-27**
   except two parked items: D4 PR 9 (vendor-gated) and the seed-gated bufio
   consumer migration. (The D8 env-merge and EncodingError rows measured
   STALE — already done; the glob row is an S3 addition, not a breaking
   change.)
4. **S3 — P0 additions.** ← next after D5 slice 2
5. **S4 — P1 additions.**
6. **S5 — stability freeze:** stable/unstable markers in `yo doc` output,
   additive-only policy documented in `yo-design.instructions.md`.

   **Two inputs measured 2026-08-27, to be worked before the freeze:**

   - **Dead public surface.** A scripted sweep of every `enum` in `std/` found
     25 variants with no production site. Most are legitimate user-supplied
     INPUTS (`Optimize.ReleaseFast`, `SeekFrom.Current`, `Signal.Interrupt` — the
     library matches on them, user code produces them), but the library-produced
     ERROR variants that can never occur are lies the freeze would lock in:
     `HttpError.{Timeout,TooManyRedirects,ResponseTooLarge}` (**C33** — now REAL,
     2026-08-28), `JsonError.InvalidNumber` (**C34** — it turned out the
     validation was missing, now FIXED), `Hash{Map,Set}Error.CapacityOverflow`
     (**C35** — same, the check was missing, now FIXED), and
     `HashMapError.KeyNotFound` / `HashSetError.ElementNotFound`, which are dead
     BY DESIGN (lookups return `Option`) and want DELETING here, in §6, since
     removing a public variant is breaking. `std/allocator`'s `Layout` /
     `layout_of` are unconsumed too — no `alloc(Layout)` entry point exists —
     which needs the same delete-or-implement decision. The struct-field face of
     the sweep came back clean apart from reflection metadata and
     `DateTime.nanosecond` (correctly populated, just never rendered — RFC 3339
     permits that, so no defect).
   - **Test coverage of the exported surface.** 1132 of 1829 `std` exports are
     never NAMED anywhere under `tests/`. That number badly overstates the gap —
     it is a name grep, so `std/sys/*` + `std/libc/*` constants dominate it and
     any type exercised only structurally (iterators reached through `for`, error
     enums appearing only in signatures) scores zero — but 183 of them sit
     outside those raw layers and want a real read before anything is marked
     stable. Freezing an export no test exercises is how a broken API becomes
     permanent (C34 was exactly that: `json_parse`'s number path had no negative
     test, so a parser that accepted `"<html>"` as `0` looked green for months).

Every stage gates on: `yo check ./std && yo check ./src`, the full language
suite, the internal suite for touched areas, `gates_fast.sh` + fixpoint, and
docs in both `docs/en-US` and `docs/zh-CN` for user-visible surface.
