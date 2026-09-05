# std API audit — the road to a stable, batteries-included standard library

**Status: IN PROGRESS.** Audit complete 2026-08-22; all §8 open questions
DECIDED by the user 2026-08-23; **S0, S1 and almost all of S2 are LANDED**
(PRs #229–#294, 2026-08-23 → 2026-08-26). Remaining: D6 PR-3 (the
curl swap, plans/D6_TLS_PLAN.md), the §7 S4/P1 tail, §9 S5 stability freeze,
and the seed-gated queue (plans/backlog/SEED_VERSION_AUTOMATION.md). D3.9
(Hasher) LANDED 2026-08-28 — plans/reference/HASHER_REDESIGN.md.
D4 PR 9 closed BY EVENTS 2026-08-28: the vendor migrated upstream
(markdown_yo ff51f91 — zero substring sites remain, and its byte-based
decoders are CORRECT by construction under the byte-indexed String), the
pointer is at the migrated commit, and the docs pipeline runs it green end
to end. D5 closed — the bufio consumer migration landed 2026-08-28 with the v0.2.18 seed (recorded
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
| C17 | `Dyn(trait)` whose method returns `Impl(Future(...))` emits the on-demand Future struct INTO the open vtable typedef; clang rejects with 7 errors. Blocks the `Dyn(Reader)` spelling of "BufReader wraps ANY Reader" | **FIXED** 2026-08-29 — vtable member lines are collected before the typedef opens (on-demand typedefs now precede it); test in dyn.test.yo — issues/fixed/dyn-trait-with-future-returning-method-splices-struct-into-vtable.md |
| C18 | **A struct literal that OMITS a required field is silently accepted** — `yo check` green, field uninitialised, program SIGSEGVs. Root: the check FIRED but was SWALLOWED in async-closure/generic def-eval, leaving codegen no ExprInfo → FTT object; **FIXED 2026-08-28** (missing-field error flags the flow-violation channel so the swallow re-raises it at check time — tests/struct_missing_field.test.yo). Directly undermines §1's "additive-only" promise: adding a field to a stable struct silently breaks every construction site not updated | **FIXED** — issues/fixed/struct-literal-missing-field-silently-accepted.md |
| C19 | C `int` passed where `i32` declared is accepted by the evaluator; codegen splices a Yo type expr into a C identifier, clang fails with a diagnostic naming nothing the user wrote **FIXED 2026-08-28** (same root as C18: the concrete-mismatch check fired but was swallowed in async-closure def-eval; now flags the flow-violation channel so it re-raises at check time — tests/int_i32_mismatch.test.yo) | **FIXED** — issues/fixed/int-vs-i32-mismatch-reaches-codegen-and-emits-malformed-c.md |
| C20 | generic-`R` callback with a unit-returning closure emitted `void* tmp = <void call>;` — `Mutex.with_lock((v) => { … })`, the flagship std/sync form, did not C-compile | **FIXED** 2026-08-26 — issues/fixed/generic-r-callback-with-unit-closure-emits-void-star-temp.md |
| C21 | a materialized async trait `?=` default resolved its `Impl(Future(...))` return to ONE concrete state-machine type for ALL implementors (`-Wincompatible-pointer-types` across implementors), ESCALATING to a hard `incomplete definition of type` C error on D5's generic BufReader (a TRIAL-era never-emitted state struct). **FIXED 2026-08-27** in two layers: per-materialization fresh RETURN SomeT cells (`_freshen_return_only_somes`, impl.yo) + emission-layer callee-channel future types (`awaited_future_c_type_override` — the sm field and the call temp now name the CALLEE's emitted return, so the static type always matches the dynamic object). Gate: the two-implementor reproducer compiles with ZERO incompatible-pointer warnings | **FIXED** — issues/fixed/async-trait-default-shares-one-impl-future-concrete-type.md |
| C22 | a closure defined INSIDE an `io.async` closure body makes that body untranspilable — compile exits 0, clang clean, binary is rc=134 (`abort()` stub), future is `_sync_fut_t` | **FIXED** 2026-08-29 — every value-returning FTT stub carries `__attribute__((error(...)))` on its first declaration, so the C compiler fails the build IFF a real call survives (dead generic originals stay harmless); the repro's body was a genuine type error the io.async trial eval swallowed; the nested-`io.async` gap is C60 — issues/fixed/closure-nested-inside-io-async-closure-body-emits-abort-stub.md |
| C23 | generic implementor (`impl(generic(T), Wrap(T), …)`) awaiting `Self.<async method>` emitted uncompilable C — two defects: static-dot `-> Self` resolution clobbered SomeT returns with the receiver, and `substitute` was not capture-avoiding (the impl's `T := usize` rewrote `Io.async`'s own `T` binder) | **FIXED** 2026-08-26 — issues/fixed/generic-implementor-async-method-awaiting-self-emits-uncompilable-c.md, tests/generic_impl_async_self.test.yo |
| C24 | **async loop over a buffer-taking await** (the D5 slice-2 blocker, found by D5 work): (a) a generic fn's `io.async` closure DROPPED the enclosing params from its capture (the `.AsyncBlock` classifier arm kept a generation-unsafe frame-level test); (b) the nullable-ptr match's payload binding (`.Some(q) => q` over `chunk.ptr()`) declared a C local while arm reads consulted the never-written hoisted `sm->var_N` slot — silent rc=139 on fully-transpiled C. Both **FIXED** 2026-08-26 (PRs #294 + #295; tests/async_generic_param_capture.test.yo, tests/async_loop_buffer_await.test.yo). (c) the generic-impl face — a materialized generic-impl arm body read the match binding through an evaluator-stamped temp the nullable-ptr emitter never shadow-registered (`_shadow_add`, the mechanism the tagged-union path always used) — **FIXED** 2026-08-26 too. ALL THREE FACETS CLOSED; generic `BufReader(R)`/`BufWriter(W)` unblocked (C17 still blocks only the `Dyn(Reader)` spelling) | **FIXED** — issues/fixed/async-loop-awaiting-buffer-taking-method-state-machine-corruption.md |
| C26 | **`out = e.io.await(...)` — RE-assigning (`=`) an await result to an existing variable silently NO-OPED the await**: three await-statement recognizers guarded on `:=` only, so inside a cond/match branch no future was stored and the whole awaiting branch skipped (every call returned the fallthrough — silent wrong values). Found by D5's BufReader bypass test; pre-existing on develop. **FIXED 2026-08-27** (extract_target_variable_id + generate_await_expression + generate_cond_branch_with_await now accept `=`) | **FIXED** — issues/fixed/assign-await-to-existing-variable-silently-noops.md, tests/async_assign_await.test.yo |
| C25 | **a unit-resolving TAIL await emitted `sm->await_result_N;`** — a field the state struct never declares for an effectively-unit result (unit, or the unresolved SomeT a where-bound trait default's `Impl(Future(unit, IoExn))` return looks like), so clang failed with "no member named 'await_result_0'". Found by D5 slice 2's first `write_all` wrapper; the completion-segment substitution lacked the effectively-unit guard the struct allocator and the extraction both had | **FIXED** 2026-08-26 — issues/fixed/unit-tail-await-of-trait-default-reads-missing-await-result.md, tests/async_unit_tail_await.test.yo |
| C27 | **generic impl method with a closure param: `io.async` return type collapses** — fixed-`T` variant awaits to `unit`; `generic(R)` variant types the method call as the CLOSURE's own fn type (future wrapper vanishes). Self-only captures and plain-`R` returns are fine — the trigger is the closure param in the async block's capture, on a generic impl. Blocks async `Mutex.with_lock` (removed from v1, restore on fix) | **FIXED** 2026-08-29 — not generic-impl materialization at all: every `Impl(...)` wrapper SomeT is NAMED `Impl`, and `try_to_call_function_with_arguments` Step 9 substituted return SomeTs from same-NAMED param args — so a closure param's fn type became the call's return; the reserved name is now excluded from that by-name match. Re-found by `HttpServer.serve_once` (non-generic). `Mutex.with_lock` still deferred (now on C54) — issues/fixed/generic-impl-async-method-closure-param-return-type-collapse.md |
| C28 | **io.await/io.spawn accepted ANY effect argument** — `io.await(fut_over_IoExn, { io })` / bare `io` type-checked, then codegen memcpy'd sizeof(IoExn) out of the smaller record (`_set_effect` ASan stack-buffer-overflow; THE cause of the red CI test legs + 6 of 8 sweep REDs since 2026-08-25). **FIXED 2026-08-27**: Step-7c layout gate (struct id or exact field-label list — the documented `{ io, exn }` structural form stays legal) + the 8 mis-written test files repaired; pinned by tests/async/effect_bundle.test.yo | **FIXED** — issues/fixed/io-await-effect-arg-not-checked-memcpy-overflow.md |
| C29 | **generic call type variables re-resolve PER ARGUMENT** — `pair_same(generic(A), x : A, y : A)` accepts `(String, i32)`; the signature's mentions of one variable resolve through separate SomeT lineages, so no cross-argument conflict is ever seen (C18's lenient struct compatibility is the second half). Memory-safety face closed by C28's gate; wrong-value faces remain | **OPEN** — issues/generic-type-var-rebinds-per-argument.md |
| C30 | **ctl handler falling through with a unit tail emitted a value-returning C fn with NO return** — the erm C signature renders the unresolved ResumeType (`void*`) while the body path treats unit as statement-tail; exposed by #275's load-bearing `-Werror=return-type` (CI internal shards 2/3: check_watch/module_invalidation batches). Fall-through = implicit RESUME WITH UNIT; codegen now closes every pointer-signature erm with `return (T*){0}` | **FIXED 2026-08-27** — issues/fixed/ctl-handler-unit-tail-missing-c-return.md |
| C31 | **`__yo_init_process_cleanup`'s lazy-init flag raced across worker threads** (TSan data race on `cleanup_initialized`, mislabeled as an RwLock test failure on the TSan CI leg) — every spawned thread runs it via `__yo_gc_init_thread`; Windows already used InitOnceExecuteOnce, POSIX/wasm had a plain static bool. Now an atomic exchange | **FIXED 2026-08-27** — src/codegen/functions/gc_runtime.yo |
| C32 | **`ThreadPool` accepted work no thread can run, then `join_all` deadlocked forever** — on standalone WASI `pthread_create` fails; pool init recorded that (`running = 0`) but `__yo_worker_spawn` ignored it and queued to the dead worker, so `join_all`'s per-worker sentinels never ran and `drained.recv()` blocked with no diagnostic (a CI leg spun **3.4 h** on one test). `Thread.spawn` had the same swallow: null handle, closure never runs, its RC captures never released (the wrapper that drops them IS the thread body), `join` a silent no-op. **FIXED 2026-08-27** — both spawn paths run the task INLINE on the submitting thread when its slot has no OS thread (the wrapper is thread-agnostic; the worker's `__yo_async_wait_all` epilogue is deliberately not run inline, which would re-enter the caller's loop), and `__yo_thread_join` skips a zero handle via a new `__YO_THREAD_HANDLE_IS_NULL` for both platform branches. The WASI skip is REMOVED: `tests/control_fn_as_regular_call` now runs all three tests there, vacuity-probed (a flipped expectation fails on WASI, so the worker body really executes) | **FIXED** — issues/fixed/wasi-thread-pool-submit-deadlock.md |
| C33 | **`HttpError` declares three failures the client cannot produce** — `Timeout`, `TooManyRedirects`, `ResponseTooLarge` were documented and formatted but never constructed. **FIXED 2026-08-28**: `FetchOptions` gained `timeout : Option(Duration)`, `max_redirects` (default 10) and `max_response_bytes` (default 64 MiB, `0` = unlimited) + `with_*` builders; `fetch_with` follows 3xx `Location` (relative and absolute-path resolved against the origin; 303 and POST-301/302 become GET) up to the cap, throws `ResponseTooLarge` before buffering past the ceiling, and races the whole exchange against a spawned `sleep` (awaited `yield`, not the blocking `timeout` combinator) throwing `Timeout`. Six loopback-server tests in tests/http/http.test.yo. Landing it surfaced SIX compiler/runtime bugs, C36–C41. (#332 landed a parallel C33 first — its `std/async.timeout`-inside-a-task race is C37 and its plain-http crash issue is C36; #331 supersedes the client and keeps its live-HTTPS tests) | **FIXED** — issues/fixed/http-client-error-variants-never-raised.md |
| C34 | **`json_parse` accepted every malformed number, and read ANY garbage as `0`** — `parse_number` scanned characters without validating and always returned `.Ok(atof(span))`, so `1.`/`1e`/`01`/`+1` all passed; and since `_parse_value` routes every unrecognized leading byte there, an empty span made `"hello"` and `"<html>"` parse as the NUMBER 0 (an HTML error page where JSON was expected → `Ok(Number(0))`, not an error; `src/lsp/server.yo` parses every JSON-RPC frame through it). `JsonError.InvalidNumber` was the dead variant that led the audit here. **FIXED 2026-08-27** — RFC 8259 §6 grammar validated before `atof`; 3 tests (2 verified RED first) | **FIXED** — issues/fixed/json-number-parser-accepts-invalid-and-any-garbage.md |
| C35 | **`sizeof(T) * count` was computed UNCHECKED in every collection** — `ArrayList.with_capacity(2^61)` for `u64` wrapped to `malloc(0)`, reported capacity 2^61, and pushed straight outside the allocation (silent heap corruption, no diagnostic); `ensure_total_capacity`'s doubling loop wrapped through zero and SPUN FOREVER; `HashMap`/`HashSet` had the same unchecked multiply behind the `CapacityOverflow` variant that was declared and never produced. `std/allocator`'s `size_would_overflow` shipped exported and called by NOTHING. **FIXED 2026-08-27** — guards at both ArrayList entry points (panic, as Rust's `Vec::with_capacity` does) with an overflow-only clamp so ordinary growth still doubles, `.Err(.CapacityOverflow)` in both hash containers, plus the `>> 32` step both power-of-two roundings were missing; new tests/allocator.test.yo (the helper had zero coverage) + a growth regression guard | **FIXED** — issues/fixed/collection-capacity-overflow-unchecked.md |
| C36 | **Dispatch-mode cond: a sibling arm's SECOND await was neither awaited nor extracted** — its continuation was parked as a `chained_branches` layer with no binding, and both dispatch emitters iterated `cbd.branches` only; `fetch_with`'s http arm read a NULL `stream` (SIGSEGV) against any loopback server — i.e. plain `http://` fetch was broken from #322 (the TLS arm) until now; the CI test only did https. **FIXED 2026-08-28** — `_dispatch_branches` unions chained layers into both switches; `_chain_additional_remaining` carries the depth's own binding | **FIXED** — issues/fixed/async-cond-dispatch-skips-chained-sibling-arm.md |
| C37 | **`io.await` in a plain (non-`io.async`) function is a nested BLOCKING event loop** — called from inside a task it froze every task below it on the C stack (deadlock the moment the awaited I/O depended on one of them). `_read_http_response` was the only std instance (made an `io.async` future in #333). **FIXED 2026-08-28**: the runtime tracks task depth and `__yo_async_poll_step` PANICS when driven from inside a task — armed by `YO_ASYNC_STRICT=1`, which `yo test` sets for every test child (the suite is enforced); default relaxed until C42; cli-case `async-blocking-await-inside-task` | **FIXED** — issues/fixed/sync-await-in-plain-fn-nests-the-event-loop.md |
| C38 | **A while-with-await inside one arm of a match/cond whose other arm awaits: the state struct never declares `while_loop_N_active`** (the merge takes the first arm's point as representative, which is not in a loop) — clang error, `yo check` green. std keeps the deadline race in its own future (`_fetch_with_deadline`) | **FIXED** 2026-08-29 (per-branch loop-ness on the merged point + dispatch-mode continuation; `fetch_with` holds the race inline again) — issues/fixed/while-await-inside-match-arm-missing-loop-field.md |
| C39 | **An `Exception(throw : (err) -> {…})` handler that assigns a captured `Box` fails inference** (`Got: Type(1)`, error pinned to line 1) | **CLOSED** 2026-08-29 — BY DESIGN (handlers are capture-free, ALGEBRAIC_EFFECTS rule 4); the swallowed diagnostic now propagates — issues/fixed/exception-handler-closure-with-box-capture-fails-inference.md |
| C43 | **A trait `?=` default method bound its `inout(self)` BY VALUE** in the per-impl materialized body: `self.field` on a pointer (clang error) or `&(self)` — a `T**` — passed to a sibling method (silent wrong value under `-w`). Every `Hasher.write_*` default is this shape | **FIXED** 2026-08-28 — issues/fixed/trait-default-inout-self-bound-by-value.md |
| C44 | **`open(import(m))` re-typed every exported integer constant from its VALUE** (`K :: u64(7)` arrived as `i32`; the named import kept `u64`) — the open loop consulted the declared type only for struct-valued members | **FIXED** 2026-08-28 — issues/fixed/open-import-retypes-integer-constants.md |
| C45 | **Non-exact compatibility unifies same-named generic instantiations by NAME only** — `(x : Result(i32, BErr)) = <Result(i32, AErr)>` type-checks (equal-name fast accept, no recursion into payload types; the struct arm has the same fast path). Sibling of the exact-comparison hole fixed as the enum-collision bug | **FIXED** 2026-08-29 (payload walk under equal names, placeholders read through their resolution cell, SomeT positions stay wildcards) — issues/fixed/lenient-generic-enum-compatibility-by-name.md |
| C48 | **An `inout(self)` method on a payload-free enum VARIANT LITERAL emitted `&(<C tag constant>)`** (`E.B.to_string()` → "cannot take the address of an rvalue"): the auto-`&` wrapper took the tag identifier for an addressable expression | **FIXED** 2026-08-29 (comptime payload-free `EnumVal` args take the spill-temp path) — issues/fixed/inout-receiver-on-enum-variant-literal-takes-address-of-tag.md |
| C49 | **`unsafe.cast(ptr, RcType)` was treated as an OWNED +1 result**: `w := unsafe.cast(user_data, Watcher)` in a runtime callback made the callee's scope-end drop free the caller's object (the fs.watch callback SIGSEGV). A cast is a borrowed view | **FIXED** 2026-08-29 (the valueless-callee result temp is non-owning for `__yo_as`) — issues/fixed/unsafe-cast-to-rc-type-is-treated-as-owned.md |
| C47 | **A function tail with a deferred dup evaluated the tail call TWICE** — the return emitter declared `T temp = <call>` for the dup and then regenerated the whole expression for the `return`; a chained `Index` tail (`rows(r)(f)`) re-declared its spill temp (C redefinition), any side-effecting RC-returning tail ran twice silently | **FIXED** 2026-08-29 — issues/fixed/deferred-dup-return-regenerates-the-call.md |
| C50 | **Two helpers forwarding different capturing closures to one function shared ONE specialization** (`(__yo_t18)(make)` where `make` is `__yo_t19`): the cache key folded closure identity only for closure LITERALS, and layout-identical capture structs compare exact-equal | **FIXED** 2026-08-29 — two halves: the resolved `capture_*` struct id joins the cache key, AND codegen no longer emits the dead UNSPECIALIZED original of a dot callee (`m.helper(closure)`) once the side table resolved the call to its specialization (that dead copy was the actual C error) — issues/fixed/forwarded-closure-param-shares-specialization.md |
| C51 | **`std/thread.get_hardware_threads` only linked when the program also used async** (its extern named the async runtime's symbol) | **FIXED** 2026-08-29 (parallelism runtime aliases it when async is absent) — issues/fixed/get-hardware-threads-links-only-with-async-runtime.md |
| C52 | **`unicode_to_lowercase` / `unicode_to_uppercase` mapped ASCII only** — the general path was C's locale-sensitive `towlower`/`towupper` in the never-set `"C"` locale (`ÉCOLE` → `École`); filed 2026-08-25, surfaced again by the S5 coverage test | **FIXED** 2026-08-29 — Yo-native tables generated from Unicode 15.1 (321 case ranges + 102 SpecialCasing expansions), verified over every scalar value against Python's `unicodedata`; `to_upper_code_point`/`to_lower_code_point` exported — issues/fixed/unicode-case-conversion-ignores-locale-so-non-ascii-is-unchanged.md |
| C46 | **Two same-shaped declared enums were ONE type to the exact comparison** (`AErr`/`BErr`, or the trimmed `HashMapError`/`HashSetError`): the CTFE memo served `Result(unit, BErr)` the `Result(unit, AErr)` instance | **FIXED** 2026-08-29 (nominal reject by declared name under `require_exact`) — issues/fixed/structurally-identical-error-enums-in-two-generic-impls-collide.md |
| C40 | **A task that re-enqueues itself on every resume (a loop awaiting `yield`) starved the I/O poll** — `__yo_async_run_ready_tasks` drained the queue until empty, so `__yo_io_poll` never ran; `fetch_with`'s deadline race spun forever. **FIXED 2026-08-28** — the drain is bounded to the queue length at entry (the async-`main` loop already capped at 100) | **FIXED** — issues/fixed/async-yield-loop-starves-io-poll.md |
| C41 | **Linux: `__yo_io_poll` never entered the kernel** — the ring runs with `IORING_SETUP_DEFER_TASKRUN`, so a busy loop that never reaches `__yo_io_wait` never saw a timer or socket complete (the C33 Timeout tests hung ONLY on the Linux legs; kqueue polls via a syscall). **FIXED 2026-08-28** — one zero-timeout `io_uring_wait_cqe_timeout` per poll | **FIXED** — issues/fixed/io-uring-defer-taskrun-poll-never-enters-kernel.md |
| C42 | **The compiler's own build scheduler nests the event loop** — `build_runner`'s DAG levels and `_compile_chunks_parallel` spawn tasks whose bodies call plain awaiting helpers (`_cache_read_file`, `_write_stamp`, `_chunk_read`, …); found the moment C37's guard first ran in CI (`yo build run` aborted). Cannot deadlock (their I/O never depends on a sibling task) but keeps the guard from being armed by default. Make the helpers futures, then flip the default | **RETIRED** 2026-08-29 — the abort was the pre-thread-local counter; strict mode is clean across init/build run/check/fmt/doc/test/version; guard stays env-gated by policy (`yo test` arms it) — issues/retired/compiler-build-runner-nests-event-loop.md |
| C53 | **`std/http` never decoded `Transfer-Encoding: chunked`** — bodies came back with the hex chunk framing, and `Content-Length` was the only completion signal (chunked responses were read only because the client sends `Connection: close`) | **FIXED** 2026-08-29 — RFC 9112 §7.1 decoder (`_dechunk`: sizes in either case, chunk extensions and trailers dropped, `Incomplete` never confused with `Malformed`), read ends at the zero chunk, typed `HttpError.MalformedChunkedBody`; loopback tests — issues/fixed/http-client-does-not-decode-chunked-bodies.md |
| C54 | **Two specializations of `-> Impl(Future(R))` collide** — the caller cast both futures to the second spec's struct (FIXED 2026-08-29), the first spec's async body renders its `body(..)` result as the second spec's `R` (FIXED 2026-08-30, #367), and the E variant — an io.async closure's bundle-param slot rendering the shared forall E through the global last-winner (the develop ASan overread) (FIXED 2026-08-31, #371: the slot renders the CALL's own recorded Future-trait effect) | **CLOSED** — `Mutex.with_lock` restored; the E variant fixed 2026-08-31 (#371: the bundle slot renders the call's own effect) — issues/fixed/future-wrapper-return-shared-across-specializations.md, issues/fixed/asan-stack-overread-set-effect-batch-selftest.md |
| C55 | **A `->` fn literal passed to `Impl(Fn(..) -> R)` does not bind `R`** (`o.map((x) -> ...)` result unusable; `=>` works) | **FIXED** 2026-08-29 — `nrs_ret_bare` gate excludes only ctl handlers (not every `->` literal) and re-registers with source param labels; test in closure.test.yo — issues/fixed/arrow-fn-literal-result-type-not-inferred.md |
| C56 | **`e.io.await(fut, bundle)` inside an `io.async` body ignores `bundle`** — the throw is delivered to the enclosing task's handlers (docs say the await-time bundle supplies the future's handlers; top-level `io.await` honours it) | **FIXED** 2026-08-29 — `emit_effect_injection_for_sm` injects the bundle named at the await (temp of the arg's type, as the top-level path does); the task's own bundle forwards only when no bundle is given; test in async_await (inner handler resumes → `Some(8)`) — issues/fixed/io-await-effect-bundle-ignored-inside-io-async.md |
| C57 | **`Command.output` drains stdout to EOF, then stderr** — a child that fills the 64 KiB stderr pipe before closing stdout deadlocks the caller (`yo test` runs every test child through it) | **FIXED** 2026-08-29 (POSIX) — stderr drained by a spawned task while stdout is awaited, AND the parent pipe ends made `O_NONBLOCK` (kqueue serviced a blocking pipe with a plain `read(2)`, parking the loop); test: 310 KiB stderr flood — issues/fixed/command-output-drains-stdout-then-stderr-sequentially.md. **Windows FIXED** 2026-08-30: empty-pipe reads park on the event-loop tick (`PeekNamedPipe`) instead of blocking `_read`; the Windows test arm runs the real flood — issues/fixed/command-output-windows-pipe-read-blocks-the-event-loop.md; pipe WRITES still block (issues/command-stdin-windows-pipe-write-blocks-the-event-loop.md) |
| C58 | **Async body: scope-end drop of a cross-boundary local, then an escape → double drop** — a cond branch that awaited released its locals inline at scope end (field left dangling), and the state machine's dispose swept every cross-boundary local again on `state == -2`; `_fetch_once` threw `Invalid status line` after its transport branch closed → heap-use-after-free (the crash behind #350's Linux sweep; reproducible on macOS with a garbage status line under GuardMalloc) | **FIXED** 2026-08-29 — `generate_drop` clears the `sm->` field after an inline drop; tests in async_await + http — issues/fixed/async-scope-end-drop-then-escape-double-drop.md |
| C59 | **Event loop blocked on unrelated I/O after the drain completed the awaited future** — `__yo_async_poll_step` (every blocking waiter) and `__yo_async_run_until_complete` (async main) ran ready tasks, then blocked in `__yo_io_wait` whenever the queue was empty and any I/O was pending, without re-checking; kqueue's 100 ms timeout hid it on macOS as a stall, io_uring waited forever (the #350 Linux hang; also why the Linux process "stayed alive on a parked accept" after main returned) | **FIXED** 2026-08-29 — block only in a step that resumed no task (the `__yo_async_wait_all` rule); main loop re-reads its state before waiting; test in async_await — issues/fixed/event-loop-blocks-after-completing-the-awaited-future.md |
| C60 | **A nested `io.async` closure inside an `io.async` body fails definition-time evaluation** — the inner bundle param's `E` is unbound during the outer body's trial (`No matching call: io.await(...)`), so the inner body used to mis-emit (`return;` in a non-void closure / abort stub); hoisting the inner body to a top-level fn works | **FIXED** 2026-08-30 — nested `io.async` binds its bundle generic from the RECEIVER when no expected type carries it (annotated closure params keep the unification path); both shapes pinned in tests/async_await.test.yo — issues/fixed/nested-io-async-inside-io-async-body-fails-def-eval.md |
| C61 | **A ctl handler returned out of its defining fn is untypeable and was silently hollow** — the def-time trial types its `unwind` against the defining fn's return, fails, and the swallow dropped the `unwind` statement from the emitted handler (`_exn()` in server.test.yo; found by the C22 stub gate; also the source of misleading per-batch `Type mismatch for parameter "fut"` errors) | **FIXED** 2026-08-30 — the evaluator rejects a control-bound fn RESULT type at definition time (outside the trial swallow); the old rule-8 tests were passing only in comptime_expect_error propagate mode; 11 test files still on the hollow helper idiom rewritten to inline installs; residual module-level-binding hole filed separately — issues/fixed/ctl-handler-escaping-its-defining-fn-is-untypeable.md |
| C62 | **`std/path` returned a path naming a DIFFERENT file, three ways** — `Path.new("../foo")` was `foo` (a leading `..` with nothing to pop was DISCARDED, so a path that escapes its directory quietly became one that does not); `Path.new("a/b").join("../c")` was `a/b/c` (`join`/`push` never saw the `..` — `new` had already deleted it — so `new` and `join` gave two answers for one path, which both module resolvers work around in comments); `Path.new("\\\\server\\share")` was `/server/share` (the UNC share became a LOCAL absolute path; the representation had no root that is not a bare `/`) | **FIXED 2026-09-05** — the audit row's open "revisit eager `..` normalization" question is DECIDED as Rust's model: `new`/`join`/`push` record components as written and the lexical fold is the new, explicitly-unsound-over-symlinks `normalize()`; `Path` gains `_prefix` for drive/UNC roots; `src/evaluator/exprs/import.yo`, `src/main.yo` and `src/doc_command.yo` now fold explicitly (the first two because the string is the module cache key) — issues/fixed/path-drops-dotdot-and-destroys-unc-prefix.md |
| C65 | **`std/http` mis-parsed a `Content-Length` field value, and read every unreadable one as "absent"** — the scan stepped over the colon AND one assumed space, so RFC 9112 §5's OPTIONAL OWS made `Content-Length:5` frame as `-1` (a server DROPS the POST body; a kept-alive client never sees the message end) and `Content-Length:12000` frame as `2000` (silent 10 KB truncation); the name was matched as a SUBSTRING anywhere in the header block, so `X-Content-Length` supplied the framing and `X-Transfer-Encoding: chunked` turned on chunked decoding for a body that is not chunked; and `parse_i32` accepted `-5`/`+5` while collapsing garbage, overflow and empty into the same `.None` → `-1` = "no such header", which RFC 9112 §6.3 forbids | **FIXED** 2026-09-05 — the header section is walked as field LINES (name anchored to a line start, colon immediately after, OWS = any run of SP/HTAB on both sides), `find_content_length` returns `ContentLength.Absent|Length|Invalid` with RFC 9112 §6.2 `1*DIGIT` parsing + an overflow guard + repeated-line agreement, and `read_http_message` throws the new `HttpError.MalformedContentLength`; 5 tests across tests/http/server.test.yo + http.test.yo, all verified RED first (the older tests all send `Connection: close`, and close-delimiting hid every one of these) — issues/fixed/http-content-length-ows-and-invalid-values.md |
| C66 | **Two silent wrong-value defects in `std/fs`** — (a) `File.metadata()` re-`stat`ed `self._path` instead of `fstat`ing its descriptor, so a `File.from_fd` handle (no path; an empty `Path` renders as `.`) reported the CURRENT DIRECTORY's size, mode and times with no error, and any handle whose file was renamed/replaced/unlinked after the open described a different inode; (b) `read_dir` mapped `readdir`'s `DT_UNKNOWN` — what XFS, many network/overlay filesystems and anything not carrying the type inline answer for EVERY entry — to `FileType.Other`, so `fs/walker` never descended (silently incomplete tree) and `remove_dir_all` called `remove_file` on directories | **FIXED** 2026-09-05 — (a) `__yo_fstat` in all four async runtimes (Linux `statx`+`AT_EMPTY_PATH`, macOS/wasm `fstat`, Windows `_fstat64`+`GetFileInformationByHandle`), surfaced as `IO_file.fstat` and `fs/metadata.metadata_fd`; this also closes §4's separate "stop `metadata` re-stat by path" item. (b) new `fs/dir.file_type` (`lstat`, so a symlink stays `.Symlink` and C9's `follow_symlinks` keeps deciding descent) called for, and only for, `DT_UNKNOWN`; the fast path is unchanged. En route, two async-codegen bugs found and filed (both worked around in std, both minimized): a value-position `cond` with an AWAITING arm inside a `while` inside `io.async` silently yields the ZERO value for every arm (issues/async-cond-value-with-await-arm-inside-while-yields-zero.md), and a value-position `cond` with a THROWING arm after an await reads an undeclared C temp (issues/async-cond-value-with-throwing-arm-after-await-undeclared-temp.md) | **FIXED** — issues/fixed/fs-metadata-restats-by-path-and-walker-drops-dt-unknown.md |
| C64 | **`GlobalAllocator.aligned_alloc` shipped with no `aligned_free`** — the only release a user could reach was `GlobalAllocator.free`, i.e. `free(_aligned_malloc(...))` on Windows, which corrupts the CRT heap; codegen had emitted a correct `__yo_aligned_free` under all four allocator configurations since mimalloc landed, and nothing in Yo bound it. Measuring the primitives also showed they disagree on the *allocation*: macOS returns NULL for a size that is not a multiple of the alignment and for any alignment below `sizeof(void*)`, glibc enforces neither, `_aligned_malloc` accepts any size — so `.None` meant "your platform", not "no memory" | **FIXED** 2026-09-05 — `aligned_free` exported, and `aligned_alloc` is now a checked wrapper (non-power-of-two and zero alignment rejected, alignment raised to the pointer size, size rounded up with an overflow guard, zero size yields one alignment-sized block); no codegen change; seven cases in tests/allocator.test.yo, Windows gated by cross-LINKING the emitted C with `zig cc -target {x86_64,aarch64}-windows-gnu` — issues/fixed/global-allocator-aligned-alloc-has-no-aligned-free.md |
| C67 | **An `Impl(Fn(...))` parameter accepted an argument that is not callable, and codegen jumped through it** — the `Fn` constraint lives on the parameter's `SomeT`, so BOTH binding routes bound the argument's type INTO that type variable before anything tested it: the inline `FuncVal` arm's argument check is gated off every `SomeT` parameter, and `check_if_function_parameter_matches_argument` synthesizes first, so its Step-8 test compared `i32` against `i32` (`[param-check] label=action declared=Impl : (Fn(E) -> T) final=i32 arg=i32 compat=true`). `apply(i32(5))` passed `check`, linked at `--optimize 2`, and the emitted C cast the integer to `int32_t (*)(int32_t)` and called it — control transfer to address 0x5 (an arbitrary indirect-branch primitive from ordinary safe Yo); the same door let `io.async` take a bare block or any value, running it EAGERLY in the enclosing function while the future was never built | **FIXED** 2026-09-05 (PR #431) — one predicate (`type_is_callable_shaped`, lifted verbatim from the valueless-callee gate `evaluate_function_call` already uses, so the argument side is judged by the same rule as the callee side) applied at BOTH binding sites before the type variable is bound, with `flag_flow_violation` so a def-time body swallow re-raises at `check` time; new code E0606 + bilingual `yo explain` entry; argument-position arms in tests/impl_fn_field_rejection.test.yo (verified RED under the seed) + one cli-case per route — issues/fixed/impl-fn-parameter-accepts-a-non-callable-argument.md |
| C68 | **`comptime_assert` never FIRED inside a function body — all 1553 of them under `tests/` verified nothing.** `evaluate_comptime_assert` returned early whenever `ctx.is_validating_function_definition || !ctx.is_executing`, and a function body — a `test("…", { … })` body included — is VALIDATED rather than executed, so the builtin was reduced to a type check on its argument. That is how the C-row work's own comptime u64 signed-arithmetic bug survived, and it made §8 O7's `comptime_assert(Type.impls(payload, Send))` pins — written *specifically* so "the expected error can only be Acyclic's" — vacuous | **FIXED** 2026-09-05 — a CONCRETE `BoolVal(false)` now throws in either mode through one shared thrower; an `UnknownVal` still only type-checks, so a runtime condition or an unspecialized generic body is untouched. Vacuity guard `tests/cli-cases/compile-comptime-assert-in-fn-body`, verified RED on the v0.2.24 seed (the harness reports `stdout_keep_match matched nothing — vacuous`). The O7 pins are now live and PASS. The fallout triage found SIX failures across three files, four of them real PRE-EXISTING compiler bugs (all reproduced on the seed): tuples derive no auto-derived marker — **FIXED** here, along with the nested-structural-type recursion guard it exposed (issues/fixed/tuple-types-derive-no-auto-derived-marker.md); generic fn types compare by binder NAME, not alpha-equivalence (issues/generic-fn-type-compatibility-is-not-alpha-equivalent.md); a same-operator chain of 4+ operands is not left-associative — `20 - 5 - 4 - 3` is 16 (issues/same-operator-chain-of-four-or-more-is-not-left-associative.md); and a comptime ENUM payload assignment is a silent no-op (issues/comptime-enum-payload-field-assignment-is-a-silent-no-op.md). The other two were genuinely stale assertions — the removed newline-associativity rule, and "an unconstrained type parameter is Runtime by default" — both corrected to the true value; the three out-of-scope bugs have their assertions PINNED to the measured value and kept LIVE so a future fix flips them red — issues/fixed/comptime-assert-never-fires-inside-a-function-body.md |

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
| conversion | `from_` / `to_` / `into_` (Rust discipline) | `to_cstr` vs `to_c_str` (resolved: `to_c_str` deleted 2026-09-03) |
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
9. ~~**Hasher redesign**~~ **DONE 2026-08-28** (plans/reference/HASHER_REDESIGN.md):
   Rust-style `Hasher` (`write(buf, size)`/`finish` required, `write_u8..u64`,
   `write_usize`, `write_i8..i64`, `write_isize` defaulted) + `Hash.hash(self,
   inout(hasher) : H, where(H <: Hasher))` in the prelude; `std/hash` with
   `SipHasher13` (keyed, streaming, pinned against an independent C
   reference), `Fnv1aHasher`, `DefaultHasher`, `hash_one`; every prelude impl,
   `String`/`ImmString` (bytes + 0xFF), `Duration`, `Option`/`Result`/`Box`,
   `derive(Hash)`, the HAMT and both SwissTable drivers rewritten; maps carry
   `k0/k1` (`new()` fixed keys for reproducible iteration — the fixpoint gate
   compares emitted C — `with_keys` for per-instance keys). The blocker
   (issues/fixed/generic-trait-method-reads-primitive-inout-self-as-pointer.md)
   had been FIXED BY EVENTS under v0.2.19; the work surfaced and fixed its
   sibling, **C43** below.
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

**D5 CLOSEOUT 2026-09-02:** the `Dyn(Reader)` spelling is unblocked (C17
fixed 2026-08-29) and now PINNED in `tests/io/async_traits.test.yo` — a
`Dyn(Reader)` dispatches `read` through the vtable, reaches the `read_to_end`
default through it, and is a valid `R` for `BufReader(R)`. The inherent-vs-
trait NAME duplication is SETTLED per D2 (one Rust-shaped name per
operation): the inherent `File.read_bytes`, `File.read_to_string` and
`TcpStream.read_bytes` are DELETED — the trait defaults `read_to_end` /
`read_to_string` are the spelling (the `fs` free functions `read` /
`read_to_string` now go through them; the deleted `File.read_bytes` also read
from offset 0 regardless of the C14 position, while the default honours it).
`write_string` / `write_bytes` / `write_str` stay: the trait has no
counterpart. The C21 caution is STALE — the slice-2 emit carries zero
`-Wincompatible-pointer-types` warnings (measured 2026-09-02). Still
standing: **C22** (no nested closures inside `io.async` bodies) and the C12
note (BufWriter's SYNC `Dispose` flush cannot await an async `Writer.write`).
Still to come: a buffered `lines()`, which waits on an async iterator
protocol (deliberately not faked).

### D6 — TLS position — **CLOSED 2026-09-04**

Every supported target has a real TLS backend: **OpenSSL on unix** (PR-1/PR-2,
2026-08-28), **Schannel on Windows** (2026-09-04), and an honest
`tls_available() == false` on wasm. PR-3 — the compiler's own curl→`std/http`
swap — **LANDED as #364 on 2026-09-02**, so `curl` is gone from
`src/version_cache.yo`; the Windows gap that left (`yo version install` and
`yo version list --remote` refusing to run) closed with the Schannel pass.
Because the `extern("Yo") __yo_tls_*` ABI is backend-agnostic, Schannel needed
**no Yo-side change** — only a second C implementation selected by the emitted
C's own `#if defined(_WIN32)` in `generate_tls_runtime`, plus `-lsecur32
-lcrypt32` on Windows targets. Full mechanism, gates and the deliberate
non-goals (client certs, pinning, ALPN, a server-side `TlsListener`) are in
`plans/D6_TLS_PLAN.md`. The historical record follows.

No TLS in tree; C1 makes https throw for now. **DECIDED (O2, 2026-08-23):
`std/crypto/tls.yo` over platform libraries (SecureTransport/Schannel/OpenSSL)
via the existing `pkg_config` mechanism, behind one `TlsStream` type
implementing the D5 traits.** **PR-1 LANDED 2026-08-28**: `TlsStream` over
OpenSSL (memory-BIO async pump, cert+hostname+SNI on, D5 Reader/Writer),
proven by a live example.com:443 handshake; `_probe_openssl` in src/main.yo
(plans/D6_TLS_PLAN.md). Remaining: route `std/http` https through it (PR-2)
and the P0+ curl→std/http swap (PR-3, the only D6 remainder); Windows
Schannel joins the Windows platform audit.
**PR-3 BLOCKED 2026-08-30 (Windows TLS) → UNBLOCKED 2026-09-01, RESCHEDULED
on the v0.2.21 seed**: the curl→std/http swap (version_cache, PR #364) is
rebased on post-#376 develop with `tls_available()` transport gating
(Windows/wasm/no-OpenSSL machines get a clean one-line error instead of a
handshake crash; Schannel stays this row's deferred item), and the emitted
TLS runtime grew a weak canary — `__yo_tls_available()` returns
`&SSL_CTX_new != NULL` — so a release bundle can weak-link OpenSSL
(`-Wl,-weak_library,…`) and still LAUNCH on a Mac without brew openssl.
**The merge gate moved to SEED_VERSION v0.2.21** (second-order bootstrap
veil, found 2026-09-01): #376 replaced std's c_include TLS with the
`extern("Yo") __yo_tls_*` ABI, and only a #376-codegen compiler emits that
runtime — the v0.2.20 seed emits the compiler-tree C with bare undeclared
`__yo_tls_*` calls, so CI's seed-built stage-1 fails at clang the moment
the swap enters the tree. Until v0.2.21 is published and SEED_VERSION
bumps, PR #364 cannot ride CI at all; local verification uses a
#376-tree-built compiler as the seed stand-in. The OpenSSL CI plumbing on
the PR branch (stage-1/stage-2 clang lines, fixpoint_only, fixpoint-arm64)
is required by either path; release.yml's own sites (Alpine cc lines, the
candidate build, the macOS bundle legs' weak-link flags, the portable-c
parse gate) ride the same branch.
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

- **`Thread.spawn` result carry (`join() -> T`) + panic propagation.**
  `join() -> T`'s compiler blocker
  (issues/fixed/spawn-closure-generic-captures-erased-to-void-ptr.md) measured
  FIXED BY EVENTS 2026-08-28 under v0.2.19 — the result carry is now an S4
  std item. Panic
  propagation is not implementable at any layer today: `panic` lowers to
  `fprintf` + `abort()`, no unwinding runtime, no per-thread recovery point.
  Do NOT accept a `join() -> Result(T, E)` signature that cannot actually
  observe a panic.
- ~~**`WaitGroup` deletion**~~ **DECIDED KEEP (2026-08-29).** Every consumer
  (`tests/imm_threading`, `tests/sync/{channel,once,rwlock,waitgroup}`) uses
  it for DYNAMIC-count waiting on threads it spawned itself — `add(n)` then
  `done()` per worker — which `ThreadPool.join_all` (whole-pool barrier),
  `Barrier` (fixed party count, reusable) and `Semaphore` (permits) do not
  express. It is a well-known primitive (Go's `sync.WaitGroup`) and stays a
  stable part of `std/sync`; the §6 row is closed as KEEP.
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
    non-UTF-8 `String`s. All fixed red-first. Filed 2026-08-25, **FIXED 2026-08-29** (table-driven, locale-free — C52):
    issues/fixed/unicode-case-conversion-ignores-locale-so-non-ascii-is-unchanged.md
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
| prelude | FIX + EXTEND | D3 traits DONE; C6 impl removals DONE; `if` macro DELETED 2026-08-30 (the v0.2.20 seed ships the parse-time desugar) |
| error/assert | EXTEND | `error.yo`'s blanket re-exports narrowed to `{ String }` + `{ ToString }` (2026-09-04 — std/error no longer leaks all of string/fmt to every importer); still: downcast, `derive(Error)`, context |
| fmt | FIX + EXTEND | `display.yo` deleted (§6); format specs DONE (D3.10); **ROW CLOSED 2026-09-04**: the four print bodies collapsed onto `_write_str`/`_write_newline`, and the numeric `ToString` impls onto one `_snprintf_to_string(comptime fmt, T, v)` helper (comptime `str` params forward into the extern call as literals — 21 sites collapsed) |
| spec/ | FREEZE AS DOC | **DONE 2026-09-04**: both files carry an EXPERIMENTAL / not-covered-by-the-stability-promise banner |
| collections/* | RENAME + EXTEND | §5 renames DONE; ~~`retain/extend`, `binary_search`, real `sort` (not O(n²) insertion), `sort_by`~~ **DONE 2026-08-28** (in-place heapsort shared by sort/sort_by, Ok/Err-insertion-point binary_search, order-preserving RC-correct retain, copying extend); ~~entry API~~ **DONE 2026-08-28** (PR #316: `get_or_insert`/`get_or_insert_with`/`update_with` — Yo-shaped, no borrow object); still: `drain`; HashSet = HashMap(T, unit) to kill ~500 duplicated SwissTable lines; hide pub `ctrl/data/…` fields; `BTreeMap` → real B-tree with `range()` (recommend: real B-tree, keep name); add `BTreeSet`; `PriorityQueue`: comparator ctor, DOCUMENT min-heap |
| imm/* | KEEP (O4) + FIX | stays in std; `Acyclic` element bounds LANDED (O7, 2026-08-27); still: iteration + `Index` where doc'd, dedupe set pair, mark unstable until exercised |
| string | FIX + EXTEND | D4 byte-indexing DONE (both types); **ROW CLOSED 2026-09-03**: Unicode-correct `to_lowercase`/`to_uppercase` (routed through `std/string/unicode`, now a LEAF module — `to_lowercase_bytes`/`to_uppercase_bytes`; the String-typed wrappers moved out to avoid the cycle) + explicitly-ASCII `to_ascii_*`; `Pattern` impls for `rune` (in string.yo) and `Regex` (in regex/index.yo; the trait gained `length_in` so `replace`/`split_once`/`strip_*` can cut); `replace`/`replace_all` Pattern-generic — a zero-width empty pattern now has Rust semantics (`"abc".replace_all("", "-")` = `"-a-b-c-"`; it used to return `self`); `split_once` (first tuple-returning std API: `Option((String; String))`), `strip_prefix`/`strip_suffix`; `parse_f64` (validates Rust's `f64::from_str` grammar itself, then `atof` — rejects whitespace/hex/trailing garbage atof would take; **its word arms returned unconditionally, so every 3- or 8-byte number answered `.None` — FIXED 2026-09-04**, issues/fixed/parse-f64-rejects-every-3-or-8-byte-number.md), `parse_i64_radix`/`parse_u64_radix` (Rust `from_str_radix` incl. overflow + i64.MIN — **and 2026-09-04 the four non-radix parsers now DELEGATE to them**: they hand-rolled digit loops with no overflow check, so `parse_i64` wrapped and `parse_i32`/`parse_u32` answered `Some(0)` for 2^64, issues/fixed/integer-parsers-wrap-instead-of-rejecting-overflow.md); `panic_dyn`/`assert_dyn` DELETED, not moved — subsumed by the ToString-generic `panic`/`assert` in std/assert (zero in-tree users); of `to_cstr`/`to_c_str` the malloc'd `*u8` `to_c_str` is DELETED (4 call sites → `to_cstr().ptr()`; `to_cstr`'s NUL-terminated `ArrayList(u8)` is the one API); `StringError` is live now (from_utf8) |
| encoding | STANDARDIZE | utf8, percent, `html_encode` + the `html_decode` rename DONE; still: one error style per D1 (toml's `Result(_, String)`; base64's string pair DELETED), base32, ~~CSV (P1)~~ DONE 2026-08-29, toml floats/arrays/dates/serializer + derives (P1) |
| json | EXTEND | enum representation DECIDED externally-tagged (O3); `JsonValue.Object` O(n) parallel arrays → keep repr, add index map if profiling demands |
| regex | POLISH | typed error + private internals DONE (D8); byte `index()` DONE (D4 PR 6); `Regex.escape`, flags-free `Regex.compile`, callback `replace_with`/`replace_all_with`, lazy `find_iter` (`RegexMatchIter`, an `Iterator`), group byte-spans (`end()`/`span()`/`group_span(i)`) DONE 2026-09-02; `impl(Regex, Pattern)` DONE 2026-09-03 — every String pattern method (`contains`/`index_of`/`split`/`replace`/`split_once`/`strip_*`) takes a compiled `Regex` (via a `_find_from` generalization of `exec`'s scan); "optional-flags `new`" is satisfied by `Regex.compile` — expression-valued `?=` defaults are not in the language (probed) — row CLOSED |
| url | EXTEND | percent-encode/decode integration, `query_pairs`/`SearchParams`, `join` (RFC 3986 §5 — needed by http redirects), builder/setters; punycode DELETED (§6) |
| io | REDESIGN | D5 — slices 1–2 DONE; generic wrappers + bufio move remain |
| fs | EXTEND + POLISH | **row re-measured 2026-09-04** (much of the old "still:" list had landed unrecorded): wrappers `copy`, `read_link`, `set_permissions`, `try_exists`, `watch`, walker glob filter (2026-08-28) and `remove_dir_all` (`std/fs/walker.yo` — the old "compiler implements it twice" note was stale, `src/fetch.yo`/`src/version_cache.yo` import std's) already DONE; `File.set_len` (ftruncate), `File.from_fd` and `DirEntry.path()` (+`parent` field) DONE 2026-09-04; still: `OpenOptions` builder; Metadata: real `btime`, `permissions()`, stop `metadata` re-stat by path; walker lazy option; collapse the `_str`/`_cstr` matrix with an `AsPath` trait |
| path | FIX + EXTEND | `Hash`/`Ord`/`Clone` DONE (#402, 2026-09-04); `join` takes any `ToString` (str/String/Path — `Path` round-trips losslessly, semantics preserved), `push` (in-place, absolute replaces), `ancestors` (stops before the empty relative path, yields the absolute root — Rust parity), `split_paths`/`join_paths` DONE 2026-09-04; **eager `..` normalization DECIDED + three wrong-value defects FIXED 2026-09-05 (C62)**: `new`/`join`/`push` record components as written (Rust's model — lexical folding is wrong over symlinks), the fold is the new `normalize()`, and `_prefix` carries a drive/UNC root so `\\server\share` survives; still: Windows separator in `to_string` (only UNC renders with backslashes, and only because its root has no other spelling), leading `.` is dropped rather than preserved as a component (Rust keeps it), `PathError` deleted (§6) — or make `new` fallible |
| fs | EXTEND + POLISH | **row re-measured 2026-09-04** (much of the old "still:" list had landed unrecorded): wrappers `copy`, `read_link`, `set_permissions`, `try_exists`, `watch`, walker glob filter (2026-08-28) and `remove_dir_all` (`std/fs/walker.yo` — the old "compiler implements it twice" note was stale, `src/fetch.yo`/`src/version_cache.yo` import std's) already DONE; `File.set_len` (ftruncate), `File.from_fd` and `DirEntry.path()` (+`parent` field) DONE 2026-09-04; `File.metadata` now `fstat`s the descriptor instead of re-stat-ing a path, and `read_dir` stats `DT_UNKNOWN` entries instead of calling them `.Other` (C62, 2026-09-05 — new `IO_file.fstat`, `fs/metadata.metadata_fd`, `fs/dir.file_type`); still: `OpenOptions` builder; Metadata: real `btime`, `permissions()`; walker lazy option; collapse the `_str`/`_cstr` matrix with an `AsPath` trait |
| path | FIX + EXTEND | `Hash`/`Ord`/`Clone` DONE (#402, 2026-09-04); `join` takes any `ToString` (str/String/Path — `Path` round-trips losslessly, semantics preserved), `push` (in-place, absolute replaces), `ancestors` (stops before the empty relative path, yields the absolute root — Rust parity), `split_paths`/`join_paths` DONE 2026-09-04; still: Windows separator in `to_string`, revisit eager `..` normalization (symlink semantics), `PathError` deleted (§6) — or make `new` fallible |
| env | MERGE (D8) | **listed items DONE 2026-09-04**: `env.remove` (unsetenv / `_putenv_s(name, "")`), `env.vars()` → `ArrayList(IterPair(String, String))` reading the C `environ` array — three-way platform split: `_environ` on Windows (ANSI copy), `_NSGetEnviron()` via new `std/libc/darwin.yo` (`<crt_externs.h>` — macOS headers do not export `environ`) on macOS, `environ` from `std/libc/unistd` on Linux — and `get`/`set`/`remove` take any `ToString` key (str literals work directly); the D8 module-merge itself is separate/unstarted |
| process | EXTEND | Child/spawn/Stdio + env + builders-return-Self + `code() -> Option(i32)` DONE 2026-08-27; `current_dir` — stale item, `env.cwd()` already covers it (Rust places it in std::env too); still: hide `raw` (needs module-private visibility) |
| cli | EXTEND or DROP-TO-PACKAGE | typed values, required enforcement, `--`, repeated opts, help-not-an-error; tty/color access DONE 2026-08-29 (`std/term`: `is_terminal`/`size`/`supports_color`/raw mode). Recommendation: keep minimal-but-correct in std |
| net | FIX + EXTEND | C2/C3 DONE; `Shutdown` enum DONE; usize counts DONE; UnixStream/UnixListener DONE 2026-08-27 (incl. their Reader/Writer impls); still: `incoming()`, UDP `connect` + typed `recv_from`, `parse_v6`, `SocketAddr.parse`, `Eq`/`Hash` on addr types, RFC 5952 V6 formatting |
| http | FIX + EXTEND | C1 DONE; ~~https over TLS~~ **DONE 2026-08-28** (D6 PR-2: scheme branch, shared generic Reader response loop, TcpStream|TlsStream transport, default port 443); ~~timeouts, redirects~~ **DONE 2026-08-28** (C33); ~~chunked decoding~~ **DONE 2026-08-29** (C53); ~~binary bodies~~ **DONE 2026-08-29** (`body : String` IS the bytes form — String is an unchecked byte buffer; pinned byte-for-byte client+server incl. invalid UTF-8, and `parse_request` now byte-slices the body — issues/fixed/http-parse-request-binary-body-boundary-panic.md); keep-alive: **DEFERRED post-freeze** (connection pooling; the client sends `Connection: close` by design and the unstable server closes per response); ~~**server (P1)**: `parse_request`, `HttpServer` on `TcpListener`~~ **DONE 2026-08-29** (`std/http/server.yo`: `HttpServer.bind/serve_once/serve/stop/close`, `parse_request`, `HttpResponse.to_string/with_status/header/with_body`, `HttpMethod.from_str` + `OPTIONS`; wire framing shared with the client in `std/http/wire.yo`; 7 loopback tests incl. a chunked request body); ~~collapse `FetchOptions` into `HttpRequest`~~ **REJECTED 2026-08-29**: `FetchOptions` is the client-policy record (JS-fetch `init` + deadline/redirect/size caps) while `HttpRequest` is the WIRE message the server parses INTO — merging would put client policy on a shared wire type; both are shipped API; the compiler's own curl→`std/http` swap (D6 PR-3) is **BLOCKED on Windows TLS** (plans/D6_TLS_PLAN.md item 3); ~~RFC 9112 §5 field-value parsing~~ **DONE 2026-09-05** (C62: the OWS after a colon is optional and is any run of SP/HTAB, field names are anchored to a line start instead of substring-matched, and an unreadable `Content-Length` is `HttpError.MalformedContentLength` rather than a silent `-1` — issues/fixed/http-content-length-ows-and-invalid-values.md); RFC 9112 §5.1 (whitespace BEFORE the colon must make a request a 400) still open — issues/http-whitespace-before-header-colon-not-rejected.md |
| http | FIX + EXTEND | C1 DONE; ~~https over TLS~~ **DONE 2026-08-28** (D6 PR-2: scheme branch, shared generic Reader response loop, TcpStream|TlsStream transport, default port 443); ~~timeouts, redirects~~ **DONE 2026-08-28** (C33); ~~chunked decoding~~ **DONE 2026-08-29** (C53); ~~binary bodies~~ **DONE 2026-08-29** (`body : String` IS the bytes form — String is an unchecked byte buffer; pinned byte-for-byte client+server incl. invalid UTF-8, and `parse_request` now byte-slices the body — issues/fixed/http-parse-request-binary-body-boundary-panic.md); keep-alive: **DEFERRED post-freeze** (connection pooling; the client sends `Connection: close` by design and the unstable server closes per response); ~~**server (P1)**: `parse_request`, `HttpServer` on `TcpListener`~~ **DONE 2026-08-29** (`std/http/server.yo`: `HttpServer.bind/serve_once/serve/stop/close`, `parse_request`, `HttpResponse.to_string/with_status/header/with_body`, `HttpMethod.from_str` + `OPTIONS`; wire framing shared with the client in `std/http/wire.yo`; 7 loopback tests incl. a chunked request body); ~~collapse `FetchOptions` into `HttpRequest`~~ **REJECTED 2026-08-29**: `FetchOptions` is the client-policy record (JS-fetch `init` + deadline/redirect/size caps) while `HttpRequest` is the WIRE message the server parses INTO — merging would put client policy on a shared wire type; both are shipped API; the compiler's own curl→`std/http` swap (D6 PR-3) **LANDED as #364, 2026-09-02**, and the Windows TLS gap it left closed 2026-09-04 with the **Schannel backend** — D6 is CLOSED (plans/D6_TLS_PLAN.md) |
| async | PROMOTE | combinator home: `join_all`, `race`, `any`, `timeout`, interval, cancellation for `JoinHandle` (`abort()`), async channel/mutex (D7). `sleep(Duration, io)` lives in `std/time/sleep.yo` — do NOT add a second one; re-export if wanted |
| thread/worker/sync | REDESIGN (D7) | ThreadPool DONE; `join() -> T` + panic propagation blocked below std — see D7 |
| time | EXTEND | ~~`Duration`: `Add/Sub` operators, `Eq/Ord/Hash`, `from_secs_f64`, `subsec_*`, consts~~ + ~~`Instant` `add/sub`, `Eq/Ord`~~ **DONE 2026-08-28** (PR #312: operators mirror add/sub incl. zero-saturation, total-nanos Hash, from_secs_f64 clamps negatives, SECOND…HOUR consts, Instant.sub clamps at clock zero); **make std USE it** (timeouts, sleeps); ~~`DateTime`: RFC3339 `parse`/`format`, component ctor, arithmetic, `Eq/Ord`~~ **DONE 2026-08-28** (leap-aware `parse` incl. lowercase t/z + space separator + nano fractions + numeric offsets, typed `DateTimeError`, validating `new`, `add`/`sub(Duration)` offset-preserving, INSTANT-basis `Eq`/`Ord` + `to_unix_utc`; `to_string` was already RFC3339 — round-trip pinned); sleep unification DONE (§5) |
| crypto | EXTEND | `Digest` trait + SHA-1 + SHA-512 + streaming Md5 + HMAC + CRC32 + `constant_time_eq` DONE 2026-08-27; `std/rand` DONE 2026-08-27 (PCG32) |
| log | REWRITE (zero users = free window) | ~~levels + `Off`, `ToString`-generic message, lazy eval, timestamps, target/module, thread-safe; keep the free-function facade~~ **DONE 2026-08-28** (PR #319: Off + Eq(Level) + get_level; generic ToString messages; `*_target`; `*_lazy` `()->String` closures gated before call; `set_timestamps` RFC3339; one mutex over filter+write). Deferred: a pluggable WRITER SINK beyond stdout/stderr (needs a Writer-trait object stored in module state) |
| testing | EXTEND | ~~`assert_eq`/`assert_ne`/`assert_approx` (diff-printing)~~ **DONE 2026-08-28** (std/assert: both-sides / shared-value / |diff|-vs-epsilon panics; optional msg; `Eq(A)+ToString` bounds; tests/assert_eq.test.yo); `bench`: auto-calibration, black_box, stddev/percentiles |
| gc/allocator | POLISH | `CustomAllocator` deletion VERIFIED 2026-09-04 (zero references); `gc.stats()` DEFERRED — the runtime only exposes `__yo_gc_collect`/`__yo_gc_tracked_count` (which std/gc.yo already wraps); real stats (bytes, cycles) need new runtime builtins |
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

- `ArrayList`: ~~`remove(start,count)` → `drain(range)`, single
  `remove(idx) -> T`, `iter()` pointer iterator~~ **DONE 2026-09-02**:
  `drain(r : Range(usize)) -> ArrayList(T)` (half-open; inverted range or
  end > len PANICS — the old count-clamping is gone, Rust `Vec::drain`
  parity), `remove(idx) -> T` (panics OOB, the `Index` impl's contract),
  and `iter() -> ArrayListIter(T)` — non-consuming iteration over the
  RC-shared handle (HashMap.keys established the shape), where
  `into_iter` moves the list. `async/channel`'s FIFO pops now use
  `remove(0)`'s returned element directly. 21 two-arg sites migrated
  (std: channel ×2, array_list retain; src: module_loader ×7,
  module_manager ×2, trait_checking ×1, codegen/utils ×1, comptime_fn ×6,
  values/impl ×2, values/type_trait_methods ×2, types/synthesizer ×3);
  single-index sites were arity-compatible unchanged.
- ~~`Http` inherent `to_string` → `ToString` impl.~~ **DONE 2026-09-02**:
  `HttpRequest` and `HttpResponse` wire-format serialization moved onto
  `impl(..., ToString(...))` (same call spelling; now also reachable through
  interpolation and `T <: ToString` bounds), matching `HttpMethod`/`HttpError`.
- ~~`str.join(items)` receiver-as-separator: KEEP (Python style) but document~~
  **DONE** (the method doc already states "with this string as separator" +
  example); `index_of`/`last_index_of` KEEP (JS names are the local norm).

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

- **`WaitGroup` — KEEP (decided 2026-08-29, see D7):** dynamic-count
  per-task waiting, which `join_all` (whole-pool barrier), `Barrier` and
  `Semaphore` do not express; a well-known primitive (Go).
- **`std/collections/linked_list.yo` — KEEP**: load-bearing half of the #249
  regression trigger (`tests/where_clause_fn_inference.test.yo`'s minimal
  era-copy/GC-trace reproducer). Revisit if that test is re-expressed.
- ~~**`base64_{encode,decode}_string`**~~ **DELETED 2026-08-29**: text is
  bytes in / bytes out — `base64_encode(s.as_bytes())` and
  `String.from_utf8(base64_decode(s, exn))`. `decode_string`'s
  `Result(String, String)` was a stringly-typed error (against D1) and its
  whitespace skipping was a lenience `base64_decode` never had; only tests
  used either. The tests now pin the byte idiom, including that whitespace is
  rejected like any other non-alphabet byte.
- **`HashMapError`/`HashSetError` dead-variant trim — compiler bug FIXED
  2026-08-29, trim SEED-GATED**: removing them makes the two enums
  structurally identical, which the exact enum comparison conflated
  (`issues/fixed/structurally-identical-error-enums-in-two-generic-impls-collide.md`
  — enums are nominal by declared name now). The compiler imports both
  collections, so the trim itself waits for a seed carrying the fix
  (plans/backlog/SEED_VERSION_AUTOMATION.md). (`HttpError.Timeout` etc. became
  REAL with C33.)
- **`StringError` — WIRED UP, not deleted** (2026-08-25 correction): it was
  "never constructed" because `from_cstr` never validates. `from_utf8`
  constructs `InvalidUtf8(cause : Utf8Error)` now; `IndexOutOfBounds` is the
  natural error for D4 bounds failures. The from_bytes rename is vendor-gated
  (D8 note).
- **Regex internals / fs-types converters / html_entities builders** — need
  either module-private visibility (Yo has none) or an internal-but-shared
  rename; a sweep cannot do it. `std/libc/*` underscore names are REAL C
  symbols and must keep them (~90 of ~101 underscore exports).
- ~~**Follow-up:** `__yo_c_macro_defined`/`__yo_c_macro_value`~~ **ROW WAS
  STALE (measured 2026-08-29): neither name exists anywhere in `std/` or
  `src/` any more.**

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
5. ~~`process.Child`/`spawn`/`Stdio`~~ **DONE 2026-08-27** (`Stdio` Inherit/Piped/Null; chainable builders returning `Self` incl. `env`/`env_clear` over a real envp built from `environ` + overrides; `spawn() -> Child` with `pid`/`write_stdin`/`close_stdin`/`read_std{out,err}_to_end`/`kill`/`wait`; parent pipe ends CLOEXEC — without it a child held the parent's stdin write end and never saw EOF; `ExitStatus.code()` is now `Option(i32)` — a signal death is `.None`, 13 consumers swept). `current_dir` DONE 2026-08-30: generation A (runtime `__yo_async_spawn_start_cwd`, all three runtimes) shipped in v0.2.20; generation B (std/sys `spawn_cwd`, `Command.current_dir`, end-to-end test) landed once that seed was live. **POSIX-only for now**: the Child/spawn plumbing and the item-4 fs wrappers have no Windows story (fs_convenience's S3 section hard-crashed the Windows CI child; sections skip on Windows) — issues/s3-fs-wrappers-windows-semantics-audit.md
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
  + releases list) with `std/http`. TLS landed (D6/O2), and the swap is
  WRITTEN on branch `s6/version-cache-std-http` — but it is **SEED-GATED on
  v0.2.20**: importing `std/http` into the compiler's own closure makes the
  v0.2.19 SEED compile `fetch_with`'s while-await-under-race shape (C38,
  fixed after the seed) and the TLS BIO externs, and the seed miscompiles
  both (`no member named 'while_loop_0_active'`, BIO decl errors) — the
  yo-seed-gates-source-forms rule in action. Land it in the first PR wave
  after SEED_VERSION advances to v0.2.20.

**P1 — expected of a modern std**
~~HTTP server~~ **DONE 2026-08-29** (`HttpServer`, one connection at a time, `Connection: close`; unblocked by the C27 fix); ~~chunked/redirect/timeout client~~ **DONE** (redirects + deadline
2026-08-28 (C33); chunked decoding 2026-08-29 (C53)); ~~TLS (D6)~~ **DONE
2026-08-28** (PR-1/PR-2; the curl→std/http swap is D6 PR-3, tracked there);
~~CSV~~ **DONE 2026-08-29** (`std/encoding/csv`: RFC 4180 reader/writer, typed
`CsvError` with byte positions, `CsvOptions` delimiter + line ending, strict
mode); ~~DateTime parse/format~~ **DONE 2026-08-28** (RFC 3339 `parse` /
`to_string`, typed `DateTimeError`); ~~`fs.watch`~~ **DONE 2026-08-30 on ALL targets** (Windows was `__yo_io_poll` skipping the fs-event tick on an empty completion port — issues/fixed/fs-watch-windows-events-never-delivered-next-spins.md; verified 4/4 on windows-latest) (`std/fs/watch`: `Watcher` over `sys/events` — inotify/kqueue/ReadDirectoryChangesW — with `poll()` and an awaitable, yield-driven `next(io)`, typed `FsEventKind` Rename/Change, `WatchOptions.recursive`, `IoError` on a missing path); ~~testing
`assert_eq` family~~ **DONE 2026-08-28** (`assert_eq`/`assert_ne`/
`assert_approx`, diff-printing); ~~log rewrite~~ **DONE 2026-08-28** (levels
incl. `Off`, generic/target/lazy messages, timestamps, thread-safe);
~~glob expansion~~ **DONE** (`std/glob`, present since the bootstrap);
~~`Semaphore`/`Barrier`~~ **DONE 2026-08-26**; ~~`ThreadPool`~~
**DONE 2026-08-26**; ~~format specs~~ **DONE**; ~~entry API + `binary_search` +
real sort~~ **DONE 2026-08-28** (`get_or_insert`/`get_or_insert_with`,
`ArrayList.binary_search`, heapsort `sort`/`sort_by`); ~~tty/terminal-size
wrappers~~ **DONE 2026-08-29** (`std/term`, unstable: `Stream`, `is_terminal`,
`size`/`size_of` → `Option(TermSize)`, `supports_color` honouring `NO_COLOR` +
`TERM=dumb`, `enter_raw_mode`/`restore_mode`; `std/cli` adoption is its own change)

**P2 — nice-to-have / decide-later**
WebSocket; YAML/XML (lean package-ecosystem); msgpack/CBOR; base58;
`BTreeSet`+range queries (with the real B-tree); bitset; `SmallVec`; LRU cache;
mmap/file-lock/statfs wrappers; `gc.stats`; DNS SRV/TXT/reverse

## 8. Open questions — ALL DECIDED (user, 2026-08-23)

- **O1 (D4)**: **byte-indexed, matching Rust — EXECUTED** (all nine PRs but
  the decoder dedup; final state and the Rust-shape amendment are in §3 D4).
- **O2 (D6)**: **platform TLS libraries**, behind one `TlsStream` implementing
  the D5 traits — **DONE, D6 CLOSED 2026-09-04.** OpenSSL on unix (probed with
  `pkg_config`, PR-1/PR-2 2026-08-28), Schannel on Windows (2026-09-04, no
  probe needed — it ships with the OS), and `tls_available() == false` on wasm.
  SecureTransport was never needed (Apple deprecated it; macOS uses OpenSSL).
  The ABI is backend-agnostic, so the Schannel pass touched no Yo code — only a
  second C implementation in `generate_tls_runtime`.
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
  `tests/imm_vec.test.yo`). **Audit residual — DECIDED + LANDED 2026-08-30:** the
  `std/sync` atomic containers (`Channel(T)`/`Mutex(T)`/`RwLock(T)`/
  `OnceCell(T)`) now require `T <: (Send, Acyclic)` like the imm family (16
  where-sites incl. the private unlocker types), each container implements
  `Acyclic` itself so they nest, and every container has a
  `comptime_expect_error` pin with an ATOMIC self-referential payload.
  `check ./std` clean — zero std consumers broke. En route: the imm_vec O7
  pin (and the first draft of these) was VACUOUS — a plain
  `ref(struct(next : Option(Self)))` payload fails the SEND bound before
  Acyclic is ever consulted; the pins now use
  `atomic(ref(struct(...)))` payloads plus a
  `comptime_assert(Type.impls(payload, Send))` guard so the expected error
  can only be Acyclic's.

## 9. Phasing

1. **S0 — correctness:** §2 — **DONE** (open compiler rows tracked in §2).
2. **S1 — conventions ADR + prelude traits (D1–D3):** **DONE** (D3.9 landed 2026-08-28).
3. **S2 — the breaking sweep (§5 + §6 + D4/D5/D7/D8):** **DONE 2026-08-27**
   except two parked items: D4 PR 9 (vendor-gated) and the seed-gated bufio
   consumer migration. (The D8 env-merge and EncodingError rows measured
   STALE — already done; the glob row is an S3 addition, not a breaking
   change.)
4. **S3 — P0 additions.** ← next after D5 slice 2
5. **S4 — P1 additions.**
6. **S5 — stability freeze:** ~~stable/unstable markers in `yo doc` output,
   additive-only policy documented in `yo-design.instructions.md`~~ **DONE
   2026-08-29**: a module's inner doc may end with a `## Stability` section
   (`unstable — new in vX.Y.Z; …`); `yo doc` carries it as
   `DocModule.stability` (HTML badge, `"stability"` in JSON, a note on the
   Markdown module page + an index badge). Every std module without the
   section is stable and additive-only — the policy, what counts as
   additive, the one-release `unstable` entry rule and the deprecation path
   are in `.github/instructions/yo-design.instructions.md` ("API stability").
   `std/encoding/csv` is the first module carrying the marker (new in this
   release); `std/http/server` and `std/fs/watch` get it in their own PRs.

   **Marker pass, 2026-09-05 (post-v0.2.24).** All four markers in the tree had
   outlived the one-release window — `std/term`, `std/encoding/csv`,
   `std/http/server` and `std/fs/watch` all shipped in v0.2.20 and were still
   marked unstable at v0.2.24 — so the window was decided module by module
   rather than left to drift:

   | module | decision | why |
   | --- | --- | --- |
   | `std/term` | **FROZEN** (marker dropped) | small surface, exercised by its tests; the stated exit condition ("while `std/cli` adopts it") is unowned and turns out to need a NEW ANSI vocabulary in two modules, not a swap. A colour vocabulary added later is additive. |
   | `std/encoding/csv` | **FROZEN** | five releases, 7 tests, no open defect. |
   | `std/http/server` | **FROZEN** | exports exactly `HttpServer` + `DEFAULT_MAX_REQUEST_BYTES`, 8 tests; concurrency and routing are additive growth. |
   | `std/fs/watch` | **stays unstable, restated** | the Windows backend is not delivered, and `ReadDirectoryChangesW`'s paired rename events are the one thing likely to move `Change`. Freezing follows Windows delivery, not a release count. |

   `std/spec/refine` and `std/spec/numeric` GAINED a marker: their
   "EXPERIMENTAL — not covered by the std stability promise" banner was prose
   with no heading, so `yo doc` published `"stability": null` for both — the
   same value it publishes for `std/string`
   (issues/fixed/std-spec-experimental-banner-is-invisible-to-yo-doc-so-both-modules-render-as-stable.md).

   Two mechanism defects fixed in the same pass: `module_stability` read only
   the FIRST SOURCE LINE of the section, so every marker longer than one line
   was published cut mid-clause in the JSON key, the HTML badge and the
   Markdown note alike; and the JSON key and HTML badge were exercised by no
   test at all (only the Markdown note was pinned). Both are now covered by
   `tests/internal/doc_stability.test.yo`.
   Found en route: `yo doc` only recognised `## ` section headings while std
   wrote `# Examples` at 70 sites — **FIXED 2026-08-29**: `# <well-known name>`
   is accepted (fenced code ignored) and std normalised to `## `
   (issues/fixed/doc-sections-require-double-hash-but-std-writes-single-hash.md).

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
     removing a public variant is breaking. **DELETED 2026-08-30** (seed gate lifted by
     v0.2.20, which carries C46's nominal-enum exact compare): both variants
     are gone, and `check ./std` under the v0.2.20 seed passes with the two
     enums' now-identical shapes. (The gate, for the record: 
     with both variants gone the two enums have identical shapes and the
     v0.2.19 seed — which predates C46's nominal-enum exact compare (#343) —
     conflates them across the std module graph (`check ./std` fails in
     `hash_set.yo` under the seed, passes under develop's compiler). They were slated for the first PR after SEED_VERSION advanced past #343 — this is that PR.) `std/allocator`'s `Layout` /
     `layout_of` are unconsumed by std but tested and useful on their own
     (a type's size + alignment as a value) — **DECIDED KEEP 2026-08-29** as
     the reflection helper they are; an `alloc(Layout)` entry point can be
     added additively if a consumer appears. The struct-field face of
     the sweep came back clean apart from reflection metadata and
     `DateTime.nanosecond` (correctly populated, just never rendered — RFC 3339
     permits that, so no defect).
   - **Test coverage of the exported surface.** **RE-MEASURED 2026-08-29: 176 of
     582 non-`sys`/`libc` exports never named under `tests/`** (the sweep is
     reproducible: every `export(...)` name outside `std/sys`+`std/libc` grepped
     across `tests/`). Most are iterator/internal types reached structurally;
     the real gaps — `hmac_sha*`, `json_parse_bytes`/`json_parse_string`/
     `json_stringify_pretty`, `eprint`, the `log` `*_target`/`*_lazy` families,
     `PATH_SEPARATOR`/`PATH_DELIMITER`, `stdin`, `get_hardware_threads`/
     `get_cpu_id`, `unicode_to_{lower,upper}case`, `is_valid_entity_code`,
     `step_len`, `bench`, the hash/http default constants — are now exercised by
     `tests/std_export_coverage.test.yo`, and writing it surfaced C50 and C51 and re-surfaced the open unicode-locale bug (C52).
     Original count: 1132 of 1829 `std` exports were
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
