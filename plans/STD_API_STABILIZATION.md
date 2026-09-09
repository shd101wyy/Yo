# std API stabilization — the 2026-09-06 audit against the code and against Rust

**Status: ACTIVE.** Successor to the remaining rows of `plans/archive/STD_API_AUDIT.md`
(whose §1–§3 decisions D1–D8 stay in force and are NOT re-litigated here). This
document is the measured state of `std/` on 2026-09-06 — every finding below was
verified by reading the implementation, not the doc comment — plus the decisions
the measurement forces and the order to do the work in.

**Goal (maintainer, 2026-09-06):** *"stabilize std APIs and make Yo battery
included; follow Rust's patterns when we can."*

**Method.** Five read-only passes over the exported surface of every module,
each comparing against the Rust counterpart (std, plus the de-facto crates:
`im`, `indexmap`, `serde_json`, `toml`, `csv`, `url`, `regex`, `glob`, `rand`,
`log`, `tokio`, `hashbrown`) and against D1/D2/D3/D5/D7. Restating a decided
convention was noise; code violating one was the target. Raw findings, with
every file:line, are in the per-group notes this plan was distilled from (see
§6).

---

## 1. Headline

The library is broad — Option/Result are Rust-complete, hashing is real
SipHash, fs/net/process/time cover the daily surface, the sync primitives are
correct and well tested — but stabilizing it today would freeze **eleven live
bugs**, **six categories of decided-convention violation**, and a trait-coverage
gap that makes most collections unprintable, un-keyable and un-defaultable.

| class | count | where |
| --- | --- | --- |
| memory-safety / UB / deadlock | 6 | `imm/vec` (leaks ×3, drop-of-uninit ×5), `Thread.join` double-join, `spawn(pool)` self-deadlock, `Send` unenforced at spawn |
| wrong value / wrong answer | 8 | `IpAddr.parse_v4`, `UdpSocket.bind` port, `Path.strip_prefix`, `DateTime.now`, `base64_decode`, `glob [a-z]`, derive fallbacks, `Rng.range` |
| performance cliff | 6 | hash tombstones → O(capacity), `html_decode` O(n²), `glob` exponential, `ArrayList.retain` O(n²), `OrderedMap.remove` O(n), `async/channel.recv` O(n) |
| D1 violations (error style) | 14 sites | `Result(_, String)` ×5, effects for pure parses ×6, `Option` for numeric parses ×8, `LinkedList.remove -> Result` vs `ArrayList.remove -> panic` |
| D2 violations (naming) | 12 | `BTreeMap.insert -> unit`, pub `size` fields, `iter()` yielding values, `get_header`/`get_level`, module-prefix stutter ×7, `has_key`, `table_len` |
| trait coverage | — | `Default` on 1/9 collections, `ToString` 1/9, `Hash`/`Ord` 0/9, `IntoIterator` on 0/6 imm types, `Eq`/`Hash` on 0/2 net address types |
| docs | ~230 names | `//` instead of `///` (dropped by `yo doc`): atomic.yo ~130, log.yo 15, metadata 13, duration 13, temp 11, url 10, collections 37 … |
| stability markers | 8 modules | `http/server`, `async/*` ×3, `sync/barrier`, `sync/semaphore`, `gc` have no `## Stability` |

---

## 2. Decisions (D9–D18) — made Rust-ward, effective now

These are the shape questions the measurement forced. Each is decided here so
the work in §4 does not re-open them.

- **D9 — `push`/`insert` are infallible; `try_*` is the allocator-aware form.**
  `ArrayList.push -> Result(unit, ArrayListError)` is discarded by **every one of
  its 12 internal callers** (`FromIterator.from_iter_add` included), while
  `ensure_total_capacity`, `with_capacity`, `HashMap.new` and `Deque.push_back`
  all *panic* on the same failure. A `Result` nobody checks is worse than a
  panic. Rust: `Vec::push` aborts on OOM. → `push -> unit` (abort), `try_push ->
  Result`; same for `HashMap.insert -> Option(V)` + `try_insert`. Breaking, one
  release. **LANDED in two PRs** — push (#468) and insert (this one). The line
  drawn: an ALLOCATION failure panics, a CALLER MISTAKE keeps its `Result`, so
  `LinkedList.insert -> Result(unit, LinkedListError)` is deliberately
  untouched (out-of-bounds index). 226 + 267 throwaway `_p :=` / `___ :=`
  bindings — invented only to swallow the discarded `Result` — are gone.
  Two hazards worth remembering: `map.insert(k, v).unwrap()` used to unwrap the
  RESULT and would now unwrap the OPTION and panic on a fresh key (the 8 sites
  were inside the `hash_map!` / `hash_set!` literal macros, which expand into
  USER code); and `check` cannot verify any of this, because it does not
  evaluate deferred generic bodies — the gate is `yo build` plus the suite.
- **D10 — `replace` replaces ALL; `replacen(pat, to, n)` is the bounded form.**
  `String.replace` and `ImmString.replace` replace the first occurrence — every
  Rust/Python/Go user gets a silently different string. → swap semantics; keep
  `replace_first` for one release as a deprecated alias. **LANDED (#464)**,
  with `replacen(pat, to, n)` as the bounded form and one `_replace_scan`
  primitive behind all four spellings. `Regex.replace` is deliberately NOT
  flipped — first-match IS the Rust regex crate's shape. The audit of all 61
  call sites found NO site that wanted first-only, and four COMPILER sites that
  were already silently wrong (Windows `\`->`/` normalisation stopping at the
  first backslash; `/./` collapsing; a "whitespace-stripped" pragma scan
  stripping one space and one tab, so a spaced `pragma( Pragma.SkipWasm )` was
  ignored and the test RAN on wasm) —
  `issues/fixed/string-replace-first-only-broke-compiler-callers.md`.
- **D11 — `PriorityQueue` is a MAX-heap, with `Reverse(T)` for min.** Today it
  is a min-heap under a name every Rust user reads as `BinaryHeap`. → flip +
  ship `Reverse(T)`; breaking. **LANDED (#465)** with `Reverse(T)` in the
  prelude next to `Ord`. Its old doc offered "negate keys for max-heap
  behaviour", which is wrong for unsigned types and for a signed minimum —
  hence `Reverse` shipping WITH the flip rather than after it. NOTE this is the
  campaign's one contestable flip and the PR says so: `PriorityQueue` is
  max-ordered in C++ but MIN-ordered in Java, so the name alone does not settle
  it; Rust's shape decides it here.
- **D12 — numeric parsing is `Result(T, ParseIntError | ParseFloatError)` via a
  `FromStr` trait and `s.parse(T)`.** Eight `parse_*` methods return `Option`,
  collapsing empty / garbage / overflow into `.None` (the C34/C65 failure mode).
  The `Option` spellings stay one release as deprecated aliases. **LANDED
  (#466)** — additive, so nothing breaks. `FromStr` carries an associated
  `Err`; `s.parse(T)` spells `T` out because it can only be inferred from the
  RESULT, which Yo does not do. Layering forced the pieces apart
  (`string` < `fmt` < `error`): enums + trait in std/string, renderings in
  std/fmt, `Error()` impls in std/error — the same split `impl(String, Error())`
  already uses. Subtlety with a regression test: the magnitude scanner can only
  report `PosOverflow`, so the signed core RE-SIGNS it.
- **D13 — pure decoders return `Result`; the effect form is a wrapper, never
  the primary.** `Url.parse`, `json_parse`(×3), `base64_decode`, `hex_decode`,
  `utf16_to_utf8` all throw through `Exception` for pure transforms; `json.yo`
  ships both styles in one file. → `Result` is the exported name; `*_exn`
  wrappers only where a caller demonstrably wants them. **PART 1 LANDED
  (#467)** — `hex_decode`, `base64_decode`, `base64_decode_url`,
  `utf16_to_utf8`. Converting the tests from "it unwound" to a direct assertion
  on the error immediately showed one passing for the WRONG reason:
  `"Zm9v YmFy"` is 9 symbols, so the 1-mod-4 LENGTH check fires before the scan
  ever reaches the space.
  **PART 2 ALSO LANDED** — `Url.parse -> Result(Url, UrlError)` (11 `exn.throw`
  sites became `return(.Err(...))`, `_parse_port` returns a `Result`, and
  `parse_exn` is the wrapper the two `std/http/client.yo` callers take, being
  already inside effect scopes); `json_parse` / `json_parse_bytes` /
  `json_parse_string` all return `Result`, with `*_exn` wrappers and
  `json_parse_result` kept one release as a deprecated alias.
  CORRECTION to this bullet's own premise: json.yo does NOT ship two complete
  parsers. There is ONE — `_parse_value`, which already returned `Result` — and
  the `json_parse*` names were thin `exn` wrappers over it, with
  `json_parse_result` a fourth wrapper. The real work was flipping which
  spelling is primary, not unifying two implementations.
  Ten error-expecting tests across url and json were written as "call it, then
  `assert(false)` — the handler unwinds so we never get here"; they now assert
  the outcome directly, and four name the variant (`EmptyInput`,
  `MissingScheme`, `InvalidPort`). One carried a comment explaining that the
  outcome had to be encoded in REACHABILITY because a ctl handler cannot
  capture an enclosing runtime local — that contortion is gone.
- **D14 — `iter()` yields POINTERS everywhere** (D2 already says so).
  `ArrayList.iter` and `OrderedMap.iter` yield values → they become
  `into_iter`; `iter` gets the pointer iterator. **LANDED (#461)** — every other
  std collection already did this, and both cheatsheets already DOCUMENTED
  `.iter()` as yielding pointers, so the code was the thing that was wrong.
  `ArrayList`'s old `iter` was a byte-identical copy of `into_iter`;
  `OrderedMap` gains a real `IntoIterator`, so `for(map, ...)` works for the
  first time, and a new `HashMap.get_entry_ptr` lets it point INTO the backing
  map rather than rebuild entries. Elements are now BORROWED, so iterating RC
  values costs no refcount traffic.
- **D15 — `Debug` is split from `ToString`.** `derive(ToString)` emits a
  structural render (Rust's `Debug`), so no error enum can derive its
  user-facing message and all ten std error enums hand-write `to_string` +
  `Error()`. → `Debug` trait + `derive(Debug)` (the current structural rule),
  `ToString` stays hand-written or comes from `derive(Error)` with per-variant
  format strings (thiserror's `#[error("...")]`). **LANDED** — `Debug` trait,
  `derive(Debug)`, and explicit `Debug` impls for the 18 primitives. It is a
  FACTORING, not a duplication: `__derive_structural_body(T, method)` produces
  the render once and `derive(Debug)` / the deprecated `derive(ToString)` each
  wrap it in their own trait, so the legacy rule is behaviourally untouched.
  A blanket `impl(T <: ToString) Debug for T` was TRIED and rejected: it
  compiles, and an explicit impl silently shadows it, but it would give any
  type with a hand-written message a `debug_string` returning that MESSAGE
  rather than a structural render — exactly the conflation D15 removes.
  `derive(Error)` with per-variant format strings is NOT done; `derive_rule`
  does receive `trait_params`, so it looks expressible.
- **D16 — `HashSet(T)` IS `HashMap(T, unit)`.** 498 of 929 lines of
  `hash_set.yo` are byte-identical to `hash_map.yo`, and the tombstone bug
  (§3) is present in both. `unit` is a true ZST as of v0.2.26, so the map's
  value slot costs nothing. Same treatment for `imm/set` over `imm/map`.
  **LANDED for `hash_set`** — 962 lines to 452, all 65 HashSet tests passing.
  `HashSet(T)` is a `ref` newtype over `HashMap(T, unit)`; the control bytes,
  quadratic probe, tombstone accounting, resize AND the hand-written `Dispose`
  all go (the backing map's `Dispose` handles cleanup).
  NOTE the tombstone half of this bullet's rationale was already STALE when
  the work started: #448 fixed reclamation in both files. The value is that the
  next such fix cannot be applied to only one of them.
  It also exposed a D2 violation the bullet does not mention: the tests read
  `capacity`, `tombstones` and `k1` as PUBLIC STRUCT FIELDS. Those are now
  delegating accessors (`capacity()`, `_tombstones()`, `_k0()`/`_k1()`).
  `imm/set` over `imm/map` is NOT done.
- **D17 — `sort` is stable; `sort_unstable` is the heapsort.** Today `sort` is
  heapsort under Rust's stable name — **LANDED**: `sort`/`sort_by` are stable,
  `sort_unstable`/`sort_unstable_by` keep the allocation-free heapsort. The
  stable path sorts an INDEX array with a bottom-up merge (a tie takes the
  left run) and then permutes the elements in place through the *same* swap
  the heapsort uses — witnessed RC-balanced with a `Dispose` counter, so no
  RC-typed uninitialised scratch exists to get `consume(p.* = v)` wrong on.
  Two things fell out: the heapsort's bare-deref swaps are NOT an `imm/vec`
  style bug (measured, suspicion refuted), and reusing the generic
  `_heapsort_by` at a second `T` tripped a specializer bug — the element
  comparator was handed the index type and the emitted C passed a `size_t`
  where the closure wanted the element struct
  (`issues/generic-fn-specialized-at-two-types-hands-the-closure-the-wrong-param-type.md`);
  the merge is monomorphic to avoid it.
- **D18 — `timeout` returns `Result(T, Elapsed)`; `Thread(T).spawn` carries
  its result and `join() -> T`.** `timeout -> Option(T)` conflates timed-out /
  aborted / `Some(None)`; D7's blocker on the join result is fixed. **FIRST
  HALF LANDED (#462)** — `timeout -> Result(T, TimeoutError)` with `Elapsed`
  and `Aborted`. Two variants, not Rust's single `Elapsed`, because Yo's
  `timeout` takes a `JoinHandle` rather than a future, which makes cancellation
  a genuinely separate failure. The two are distinguishable ONLY inside the
  poll loop, so the deadline arm records which arm ended the wait. **SECOND HALF NOT LANDED — blocked from BOTH directions.** The std-side design
  is written and works in isolation (`Thread(T)` holding a capacity-1
  `Channel(T)`; `join` keeping the join-once assert and detach-on-drop
  `Dispose` before `try_recv`; `Thread(i32).join()` returning the body's
  value), but it cannot be landed:
  * writing the call-and-send INLINE in the spawn closure does not compile at
    `T = unit` — the emitted C is `void* tmp = <void expr>` for the captured
    callback's ZST result and the `Channel(unit).send` specialisation is never
    emitted. Narrowed to `src/codegen/exprs/parallelism.yo`, which gives spawn
    callbacks their own capture-struct lowering ("selects the primitive +
    (unit) return convention"), with three controls that all work.
  * routing it through a top-level generic helper dodges that, and then hits
    the OTHER wall: the spawn closure now CAPTURES `cb`, and #451's Send
    enforcement rejects it —
    `Captured variable 'cb' ... does not implement Send`. Adding the `Send`
    bound to the helper's parameter does NOT help, because
    `_capture_judgement_type` resolves a captured closure to its own CAPTURE
    STRUCT and judges that; one more level of nesting puts a struct in front
    of the checker that carries no `Send` impl. Before this change `cb` went
    straight to `__yo_thread_spawn` and was never a captured variable, so the
    check never saw it.
  Landing it therefore needs a compiler change — either the ZST lowering or
  teaching the capture judgement to see a closure whose own captures are all
  `Send` as `Send`. The latter is a security-relevant checker and should not be
  rushed. Evidence and the ready design:
  `issues/thread-spawn-callback-returning-a-zst-emits-void-star-from-void.md`.

- **D19 — `Box` KEEPS its name, and says loudly that it is Rust's `Rc`.**
  (Maintainer, 2026-09-06.) `Box(V)` is `ref(struct((*) : V))`, so copying a
  handle shares one heap value and bumps a refcount — Rust's `Rc<T>`, not
  Rust's `Box<T>`. It is not renamed to `Rc` because **`Rc` is already a trait
  in the prelude** (`std/prelude.yo:201`, the "this type is a reference-counted
  `object` type" bound spelled `where(Self <: Rc)`), so the name is taken and
  the collision would be the worse confusion. It is also not renamed to
  something new, because reference counting is Yo's *universal* object model
  rather than one container's opt-in policy: every `ref(struct(...))` is
  refcounted and `Box` is just the one-field case, so singling it out with an
  "the RC one" name would mislead in the other direction. The cost is paid in
  documentation instead — the prelude doc now opens with "`Box` is Rust's
  `Rc`, NOT Rust's `Box`", a worked sharing example (verified: writing through
  the second handle is visible through the first), and the three consequences
  that bite Rust readers (silent sharing, cycles leak, `rc`/`Iso` for
  uniqueness).

---

## 3. P0 — fix before anything is frozen (each with its file:line)

Memory safety / UB / deadlock:

1. **`std/imm/vec.yo` leaks and drops uninitialized memory.** — **FIXED 2026-09-06 (#445, `8d5523d84`)** `push` grow
   (144-149) and `concat` grow (236-247) `free` the old buffer without dropping
   the elements `_copy_elems` (87-100) dup'd; `pop`'s unique path (189-193)
   leaves the popped slot outside the `Dispose` loop. `map` (292), `filter`
   (304), `reverse` (281), `dedup` (408), `zip_with` (425) write `p.* = v` into
   fresh `malloc` memory — a bare deref-assign drops the garbage destination;
   only `consume(p.* = v)` initializes. All silent for RC element types; every
   test uses `i32`. Deque/ArrayList do both correctly (`deque.yo:60-72`,
   `array_list.yo:250`).
2. **`Send` is not enforced at any spawn boundary.**
   `validate_capture_trait_requirements` is a no-op stub
   (`src/evaluator/utils/closure.yo:125-132`); the `Send` on
   `Thread.spawn`/`spawn(pool)` (`thread.yo:40,45,57,211`) is decorative. A
   closure capturing a non-atomic `ref` struct, an `Io` or a `JoinHandle`
   crosses an OS thread. Compiler fix + `comptime_expect_error` negatives —
   **FIXED 2026-09-06**: the stub is the faithful TS port, called from both
   closure-creation routes; raw-pointer captures still slip through until
   `issues/type-impls-reports-true-for-a-blanket-impl-whose-where-clause-fails.md`
   is fixed (`issues/fixed/send-was-not-enforced-at-spawn-boundaries.md`).
3. **`spawn(pool, …)` self-deadlocks on nested spawn** whenever the runtime
   takes its inline fallback: the pool mutex is held across
   `__yo_worker_spawn` (`thread.yo:218-221`) and the fallback runs the task on
   the submitting thread (`codegen/parallelism/runtime.yo:463-468`) — **FIXED
   2026-09-06**: the submission lock is re-entrant for its owning thread
   (`issues/fixed/thread-pool-spawn-self-deadlocked-in-the-inline-fallback.md`).
4. **`Thread.join` is re-callable (double `pthread_join`, UB) and `Thread` has
   no `Dispose`** (`thread.yo:61-64`; threads are created joinable and never
   detached, `runtime.yo:141-167`) — every un-joined thread leaks — **FIXED
   2026-09-06**: `Thread` is a `ref` struct with a `_joined` flag (second
   `join` panics) and `Dispose` detaches through the new `__yo_thread_detach`
   (`issues/fixed/thread-join-was-re-callable-and-handles-leaked.md`).
5. **`html` entity tables lazy-init through unsynchronised globals**
   (`encoding/html.yo:21-31`); **`std/log` globals raced** (`log.yo:81-101`,
   `168`) against a module doc that promises one mutex — **FIXED 2026-09-06**:
   eager module-init tables; every log global access under `_log_mutex`
   (`issues/fixed/html-and-log-globals-raced.md`).

Wrong values:

6. **FIXED 2026-09-06 (#446, `b8e5cfb76`)** — **`IpAddr.parse_v4`** accepts `"..."` as `0.0.0.0` and wraps octets past
   `u32` (`net/addr.yo:37-88`).
7. **FIXED 2026-09-06 (#446)** — **`UdpSocket.bind` echoes the bind argument** so an ephemeral-port bind
   reports port 0 (`net/udp.yo:87`; TCP got this fix as C2, `tcp.yo:168-181`);
   **`UdpSocket.send` requires a `connect` that does not exist** (`udp.yo:119`).
8. **`Path.strip_prefix` is node's `relative` under Rust's name** — emits `..`
   segments instead of the remainder-or-error (`path.yo:561`) — **FIXED
   2026-09-06**: `strip_prefix -> Option(Path)` (remainder or `.None`, like
   `String.strip_prefix`); the node behaviour survives as `relative_to`, which
   the compiler's four display-path callers now use
   (`issues/fixed/path-strip-prefix-was-nodes-relative.md`).
9. **`DateTime.now()` returns UTC and calls it local** (`time/datetime.yo:117`)
   — **FIXED 2026-09-06**: the zone offset comes from `localtime_r`
   (`_localtime64_s` on Windows — MSVC's `localtime_s` has REVERSED arguments)
   (`issues/fixed/datetime-now-returned-utc-and-called-it-local.md`).
10. **`base64_decode` accepts `len % 4 == 1` and non-canonical trailing bits**
    (`encoding/base64.yo:79-110`) — **FIXED 2026-09-06**: `InvalidLength` /
    `InvalidLastSymbol(ch)` (`issues/fixed/base64-decode-accepted-impossible-lengths-and-trailing-bits.md`);
    **`glob` `[a-z]` ranges are not implemented** (literal compare,
    `glob.yo:133-150`) and `*` backtracks exponentially (`glob.yo:22-88`) —
    **FIXED 2026-09-06**: iterative single-`*` matcher (recursion only at
    `**`), ranges, POSIX `]`-first and literal `-`
    (`issues/fixed/glob-ranges-unimplemented-and-star-exponential.md`).
11. ~~**Four `derive_rule`s degrade silently on a non-struct/enum**~~ —
    **WITHDRAWN 2026-09-06 (#447)**: the `derive` builtin itself already rejects
    anything but a struct or enum ("derive only works on struct and enum
    types"), verified against the develop prelude, so the rules' `true =>`
    fallback arms (`Eq` → always true, `Ord` → all equal, `Hash` → feeds
    nothing, `Clone` → shallow) are dead code behind that guard. Pinned by
    `tests/derive.test.yo` (five `comptime_expect_error` rejections + the
    smallest-aggregate canaries) rather than by new prelude code.
    **`Rng.range(x, x)` is a SIGFPE** (`rand.yo:68`) — **FIXED #447**: it was a
    silent wrong number on arm64 (`range(3, 3)` → 0) and a SIGFPE on x86;
    `range` and `next_below` now panic with a message naming the call
    (`issues/fixed/rng-range-and-next-below-divide-by-zero-on-an-empty-range.md`).
12. **`fmt.Writer.to_string` aliases the writer's live buffer**
    (`String.from_bytes` stores the `ArrayList` by reference, `writer.yo:187`)
    — **FIXED #447**: the buffer is handed over and the writer reset
    (`issues/fixed/fmt-writer-to-string-aliases-the-live-buffer.md`).

Performance cliffs that are correctness in practice:

13. **Hash tombstones are never reclaimed** — `remove` writes `CTRL_DELETED`
    but `_needs_resize` counts only live `size`, so insert/remove churn degrades
    every probe to O(capacity) (`hash_map.yo:254-259, 429`; `hash_set.yo:246,
    385`) — **FIXED 2026-09-06**: a `tombstones` count feeds the load
    threshold, a mostly-tombstone table rehashes in place, and an isolated
    remove goes straight back to `EMPTY`
    (`issues/fixed/hash-tombstones-are-never-reclaimed.md`). **`Deque._grow`
    has no C35 overflow guard** (`deque.yo:50-52`), nor does
    `imm/vec._raw_alloc` (`vec.yo:79`) — **both guarded, FIXED in #445**.
14. **`html_decode` is O(n²)** — rebuilds the result via a template string per
    character (`html.yo:162` + 12 sites) — **FIXED 2026-09-06**: appends in
    place into a pre-sized `String`. **`ArrayList.retain` is O(n²)** with an
    allocation per rejection (`array_list.yo:1160-1173`) — **FIXED 2026-09-06**:
    one pass over push / clear / extend, `rc()`-witnessed
    (`issues/fixed/array-list-retain-is-quadratic.md`).

Convention violations that change signatures (do them in the same breaking
window as D9–D18):

15. **`Result(_, String)` in five exported APIs** — `env.cwd/current_exe/chdir`
    (`env.yo:166,266,414`) and `http.parse_request/parse_response`
    (`http.yo:231,313`) — **BOTH HALVES FIXED 2026-09-06**.
    *http half*: `HttpParseError` enum (D13), variants carrying the offending
    text (`issues/fixed/http-parse-errors-were-bare-strings.md`).
    *env half*: all three return `Result(_, IoError)` — Rust's shape
    (`env::current_dir`, `env::current_exe`, `env::set_current_dir` are all
    `io::Result`, none of them throws). The "should throw `IoExn`" note
    predated the call-site survey: **all 28 `src/` call sites discard the
    payload** and fall back to `"."`, so throwing would have forced 28 handler
    installs to rebuild that fallback. Errors now carry the real reason —
    `errno` on POSIX, `GetLastError()` on Windows, `NotSupported` on wasm —
    captured *before* the error path's `free()`, which may clobber `errno`
    (`issues/fixed/env-cwd-current-exe-chdir-returned-stringly-typed-errors.md`).
    Two latent defects fell out en route: `std/libc/errno.yo` declared
    `errno : *int`, so reading it was a C type error and nothing in the tree
    ever had (`issues/fixed/libc-errno-was-declared-as-a-pointer-and-was-unusable.md`),
    and `IoError.Other(code)`'s `to_string` discarded the code
    (`issues/fixed/ioerror-other-discarded-its-os-error-code.md`).
16. **`BTreeMap.insert -> unit`** drops the old value (`btree_map.yo:77-82`) and
    discards `push`'s `Result` then underflows `len() - 1` (:86-87); same
    discard in `priority_queue.yo:49` — **FIXED 2026-09-06**: `insert ->
    Option(V)` (the replaced value), both push results guarded
    (`issues/fixed/btree-map-insert-dropped-the-old-value-and-push-results-were-ignored.md`).
17. **`Child.kill -> i32` errno** (`process/command.yo:635`) → throws `IoExn` —
    **FIXED 2026-09-06**: `kill(signum, exn)` throws the errno as an `IoError`
    through `IoError.check` (`issues/fixed/child-kill-returned-a-raw-errno.md`).
18. **One malformed request kills `HttpServer.serve`** — framing throws
    propagate out of the loop (`http/server.yo:86-113`); and `http/server` has
    no `## Stability` marker, so this shape is already frozen — **FIXED
    2026-09-06**: `read_http_message_result` returns the framing defect as a
    value (D13), the server answers 413/400 and keeps serving, `## Stability:
    unstable` added. Peer-reset I/O errors still propagate — recovery needs a
    catch primitive (`issues/unwind-from-a-handler-installed-inside-io-async-exits-main-with-rc-0.md`)
    (`issues/fixed/one-malformed-request-killed-http-server-serve.md`).

---

## 4. P1 — expected of a modern, Rust-shaped std (by module group)

> **RE-MEASURED 2026-09-08, after v0.2.28.** This list was written 2026-09-06;
> the D-batch and #473/#474/#476/#477 landed since. Every row below was
> re-checked against `origin/develop` by grepping for the METHOD ENTRY
> (`  name : (fn(`), not the bare name — a bare-name grep reports a local
> `first :: elems.car()`, a doc comment, and an `import` line as hits, and did
> so three times while measuring this. **Eight rows are already done or are
> narrower than written** and are corrected below; everything else was confirmed
> still missing.

**Already DONE — strike these from the list:**

| row as written | actual state |
| --- | --- |
| `Alignment` exported | done — `std/fmt/writer.yo:22` |
| `JoinHandle` `Dispose` | done — Yo's `Thread` IS Rust's `JoinHandle` and has `Dispose` (`std/thread.yo:88`, detach-on-drop) |
| HTTP byte bodies (*"`parse_response` string-concats the body — binary responses are broken client-side"*) | **done, and the claim is stale**: the body is copied byte-wise and wrapped with unchecked `String.from_bytes` (`std/http/http.yo:363-374`), byte-transparent end to end, pinned by `tests/http/server.test.yo` |
| `OrderedMap` `IntoIterator` | done via D14 — `std/collections/ordered_map.yo:319` |

**Narrower than written — the neighbouring capability exists, the asked-for one does not:**

| row as written | actual state |
| --- | --- |
| `Seek` trait | `SeekFrom` exists (`std/fs/types.yo:66`); there is no `Seek` TRAIT |
| `Reader.read_exact` as a default | exists as a `BufReader` method (`std/io/bufio.yo:137`); NOT a `Reader` trait default |
| `Stdout.write_string` | exists on `BufWriter(W)` (`std/io/bufio.yo:235`); NOT on `Stdout` |
| `FromIterator` on `HashMap`/`BTreeMap`/`imm/*` | exists on `HashSet` only (`std/collections/hash_set.yo:411`); `hash_map.yo` and `btree_map.yo` have zero |

**Confirmed still missing** (spot list; the group paragraphs below stand otherwise):
`ArrayList` — `first/last/insert/swap/swap_remove/truncate/resize/fill/dedup/
split_off/append/chunks/windows/starts_with/ends_with/sort_by_key/
binary_search_by/reserve` (all 18). `HashMap` — `entry/retain/extend/
remove_entry/get_key_value` (all 5). `Deque.front`/`back`. `BTreeMap` —
`contains_key/range/pop_first/pop_last`. `OrderedMap.swap_remove`. `imm/*` —
no `Iterator` on any of the six collection types (`imm/string.yo:627` has one).
Text — every listed `String` method, `next_back`, `is_ascii_*` renames. Encoding
— `Url.join/query_pairs/path_segments`, `JsonValue` mutation/`as_i64`/`pointer`,
`EncodingError` offsets, regex naming, `glob()`. I/O — `OpenOptions`, `Watcher`
`Dispose`, `SystemTime`/`UNIX_EPOCH`, `SocketAddr` `Eq`/`Hash`,
`TcpStream.local_addr` (it is on `TcpListener`), `TcpListener.incoming`,
`StatusCode`, `HeaderMap`. Core — **all of it**: every `checked_/wrapping_/
saturating_/overflowing_`, `abs/pow/clamp/count_ones/leading_zeros`, every
`f64`/`f32` method and const (only raw `libc/math` today), `Error.is`,
`ErrorChain`, `Context`, `derive_rule(Error)`, `black_box`, log `Sink`/`YO_LOG`,
`thread_rng`. Concurrency — `Thread` is NOT generic and `join -> unit`
(`std/thread.yo:61,78`), so **D18b is still open**; `Sender`/`Receiver` split,
`Mutex.try_lock`, `Condvar.wait_timeout`, `RwLock.try_*`,
`Semaphore.with_permit`, `interval`, `spawn_blocking`, `TryRecvError` all absent;
`_raw_lock` is still public (`std/sync/once.yo:70`) — that row asks for REMOVAL,
so "present" means the work remains.


**Collections.** `IntoIterator`/`Iterator` on every `imm` type (zero today);
`Default`/`Eq`/`Clone`/`ToString` on all nine collections, `Hash`/`Ord` where
Rust has them; `FromIterator` on `HashMap`/`BTreeMap`/`imm/*` (one spelling of
"from a sequence" instead of `from_list`/`from_entries`/`FromIterator`, whose
`to_list`/`from_list` are not even inverses); `ArrayList`: `first/last/insert/
swap/swap_remove/truncate/resize/fill/dedup/split_off/append/chunks/windows/
starts_with/ends_with/sort_by_key/binary_search_by`, `reserve(additional)`
(today's `ensure_total_capacity` takes a TOTAL — a footgun under Rust's name);
`HashMap`: real single-probe `entry` API, `retain`, `extend`, `remove_entry`,
`get_key_value`; `Deque.front/back`; `BTreeMap.contains_key/range/pop_first/
pop_last`; `OrderedMap` O(1) `swap_remove` + `IntoIterator`; `imm` `remove`
returns presence/value (`(Self, Option(V))`); `imm/Vec` doc says persistent but
is flat COW — fix the doc or the structure; public `ctrl/data/size/…` fields
made private.

**Text.** **`find`/`rfind` REJECTED (2026-09-08, maintainer)** — `String` keeps
`index_of`/`last_index_of`. The reason is internal to Yo, not stylistic: the
prelude already defines `Iterator::find(pred) -> Option(A)` returning the
ELEMENT, beside `Iterator::position(pred) -> Option(usize)` returning the index.
Making `String.find` return an index would leave `.find(` meaning two different
things depending on the receiver — the same wart Rust carries because `str::find`
predates its `Iterator` conventions, and there is no reason to import it
deliberately. It would also make the std LESS uniform, since the collections
cannot follow: `ArrayList`/`imm::Vec` `index_of` take a VALUE, Rust's
index-returning `position` takes a PREDICATE, and `find` is spoken for. So
`index_of` stays the one spelling across `String`, `imm::String`, `ArrayList` and
`imm::Vec`. `next_back` on all four string iterators (D4 promised
`chars().rev()`; it does not exist); `lines()` strips `\r`; `rune`'s six
ASCII-only methods renamed `is_ascii_*`/`to_ascii_*` with Unicode versions from
`unicode.yo`; `String`: `splitn/rsplit/split_whitespace/trim_*_matches/replacen/
find/rfind/eq_ignore_ascii_case/is_ascii/insert/remove/truncate/pop`; one
string builder (three vocabularies today); `fmt.Writer.write_padded` pads by
bytes while `FormatSpec` pads by runes; `Alignment` exported.

**Encoding.** `Url.join/query_pairs/path_segments/set_*` (http hand-rolls
redirect resolution because `join` is missing); `JsonValue` mutation (`insert/
remove/object()`), `is_*`/`as_i64`/`as_u64`, `pointer`, integer arms; TOML
floats/arrays/dates/inline tables/escapes/comments/serializer (today ~⅓ of the
format); `EncodingError` with offsets; regex Rust-shaped names (`is_match/find/
captures/find_iter`, `new(pattern)` one-arg); `GlobPattern.new -> Result` +
filesystem `glob()`; module-prefix stutter (`json_parse` → `json.parse` …).

**I/O.** `Seek` trait; `Stdout.write_string`; `Reader.read_exact` as a
default; `Child` stdin/stdout/stderr as `Reader`/`Writer` handles; `Watcher`
`Dispose`; `OpenOptions`; lazy `read_dir`; `Metadata.modified() -> SystemTime`
with a real `SystemTime`/`UNIX_EPOCH` in `std/time`; `SocketAddr`/`IpAddr`
`Eq/Hash/Ord/Clone` + `parse`/`parse_v6`; `UdpSocket.recv_from -> (n, from)`;
`TcpStream.local_addr`, `TcpListener.incoming`; HTTP `StatusCode` + `HeaderMap`
+ byte bodies (`parse_response` string-concats the body — binary responses are
broken client-side) + keep-alive.

**Core.** `checked_/wrapping_/saturating_/overflowing_` on every integer (zero
today), `abs/pow/clamp/min/max/count_ones/leading_zeros/…`; `f64`/`f32`
methods and consts (`sqrt/abs/floor/ceil/round/is_nan/EPSILON/INFINITY/NAN` —
today only raw `libc/math`); `Error` ergonomics: `is(T)`, documented
`downcast`, `ErrorChain`, `Context(msg, source)` (nothing in the tree overrides
`source`); `derive(Error)` (D15); `Default` on ~15 more types; `bench`
`black_box` + auto-calibration; `log` `Sink` trait + `YO_LOG`; `rand`
`thread_rng`/`random()`/`Range`-typed `range`.

**Concurrency.** `Thread(T).spawn` + `join() -> T` (D18); `Sender`/`Receiver`
split with auto-close on last sender; waker-based `yield`/`async channel`/
`async mutex` instead of 1 ms timer polls; `async/mutex.with_lock` either takes
an `io` (so its doc claim becomes true) or drops the claim; `Once.call`
rewritten over `Mutex.with_lock` (its blocker is in `issues/fixed/`);
`_raw_lock`/`_raw_unlock`/`_raw_handle_ptr` off the public surface;
`JoinHandle` `Dispose`; `Mutex.try_lock`, `Condvar.wait_timeout`,
`RwLock.try_*`, `Semaphore.with_permit`, `interval`, `spawn_blocking`;
`try_recv -> TryRecvError{Empty, Disconnected}`; a concurrent test for `Mutex`
(it has none).

---

## 5. Maintainer decisions still needed

- `imm/Vec`: implement structural sharing (RRB), or re-document as a flat COW
  array and accept O(n) on shared mutation?
- `MemoryOrder.Consume`: keep (C11 has it; every compiler promotes it to
  `Acquire`; Rust omits it) or remove?
- `HashMap.new()` stays deterministic-keyed (the fixpoint gate depends on
  byte-identical emitted C); ship `with_random_keys()` for programs that face
  untrusted keys?

---

## 6. Phasing

1. **P0 memory/UB/deadlock (§3 1–5)** — **DONE** (all 17 §3 rows carry a FIXED/LANDED marker). One PR per module (`imm/vec`,
   `thread`, `html`+`log`), each with red-first tests over RC element types
   under `MallocScribble`; the `Send` enforcement is a compiler PR with
   `comptime_expect_error` canaries and an over-rejection canary per exempt
   shape.
2. **P0 wrong values + cliffs (§3 6–14)** — **DONE**. Small PRs, each a bug with its test.
3. **The breaking window (§2 + §3 15–18)** — **SHIPPED in v0.2.28** (not the
   v0.2.27 originally targeted; the batch grew and slipped one release). Every
   D9–D18 decision landed except **D18b** (`Thread(T).join() -> T`), which is
   blocked on a compiler fix — `Thread` is still non-generic with `join -> unit`.
   Breaking changes are in the v0.2.28 release notes; deprecated aliases kept
   for one release are `derive(ToString)` and `json_parse_result`.
4. **P1 additive work (§4)** — IN PROGRESS, re-measured 2026-09-08 (see the §4
   banner: eight rows already done or narrower than written). Module by module,
   `## Stability` marker on every module touched, `///` sweep of the same module
   in the same PR.

   **Collections: DONE** as of 2026-09-08. `ArrayList` has all 18 rows
   (`first/last/insert/append/swap/swap_remove/truncate/split_off/reserve/
   dedup/starts_with/ends_with/resize/fill/sort_by_key/binary_search_by/
   chunks/windows`); `HashMap` has a real single-probe `entry` API plus
   `retain/extend/remove_entry/get_key_value`; `Deque.front`/`back`;
   `BTreeMap.contains_key/range/pop_first/pop_last`; `FromIterator` on
   `HashMap` and `BTreeMap`. Two shapes are deliberate divergences from Rust,
   documented at the definition: `chunks`/`windows` yield COPIES because Yo has
   no slice type, and `extend` is bounded by `IntoIterator`, which an iterator
   does NOT satisfy (issues/blanket-into-iter-is-not-an-intoiterator-impl.md).
   `imm/*` now has `IntoIterator` on all six containers (2026-09-08):
   `List` walks its cons chain and `Vec` its flat array, both O(1) per step;
   `Map`/`Set`/`SortedMap`/`SortedSet` delegate to the `List` their existing
   `entries()`/`to_list()` already returns, and say so rather than pretending
   to be lazy — a stack-based cursor over the trie/RB-tree is the future
   optimization. `SortedMap` gained the `entries()` it was missing beside
   `imm.Map`'s.

   Still open in this group: `imm` `remove` shape,
   `OrderedMap.swap_remove`, private `ctrl/data/size` fields, the `imm/Vec`
   RRB-vs-flat-COW doc (§5).

   **Evidence for that §5 decision, found while writing the iterator tests:**
   `imm.Vec.push` takes `own(self)`, so the receiver is MOVED and keeping the
   earlier version requires an extra binding (`kept := v; bigger := v.push(x)`)
   — which is also what pushes the refcount above one and sends `push` down its
   copying path. That is a coherent flat-COW design, but it is not what a reader
   of the word "persistent" expects, and the ergonomics are the argument for
   fixing the DOC rather than the structure.

   **Core numerics: integers DONE, floats UNBLOCKED.** Every
   `checked_/wrapping_/saturating_/overflowing_` plus `abs/pow/clamp` landed as
   ONE generic impl over an `Integer` marker trait. The `f64`/`f32` half was
   blocked by three compiler bugs, all found by trying to write it and two now
   fixed: a non-finite comptime float emitted `inf.0`
   (issues/fixed/comptime-float-infinity-emits-invalid-c.md) and a `c_include`d
   constant never emitted its header
   (issues/fixed/c-include-global-does-not-emit-its-header.md). The module home
   is decided: **`std/math.yo`**, following `std/string/rune.yo`, which already
   gives a PRIMITIVE type inherent methods from a non-prelude module — the
   prelude imports nothing and has no `c_include`, so it cannot host them. Its
   constants are Yo literals rather than libc's, which sidesteps
   issues/c-include-rvalue-macro-constant-cannot-be-addressed.md and is the
   better design anyway (comptime, no header dependency).

   **`Default` coverage: DONE (2026-09-09).** The finding was "Default on only
   16 types: 13 primitives, `Option`, `String`, `ArrayList`". It is now on 24
   more: the seven remaining mutable collections (`HashMap`, `HashSet`,
   `BTreeMap`, `Deque`, `LinkedList`, `PriorityQueue`, `OrderedMap`), all seven
   `imm` containers, `Duration`, `Path`, `StringBuilder`, `Writer`, `rune`,
   `SipHasher13`, `Fnv1aHasher`, `JsonValue`, `unit` and `Box(T)`. Each is the
   Rust value: the empty container, `Duration::default()` = zero,
   `char::default()` = U+0000, `serde_json::Value::default()` = `Null`,
   `Box<T: Default>` = `box(T::default())`. Every one carries a RUNTIME test
   asserting the default is not just constructible but usable (insert into it,
   push onto it, render it) — `yo check` never evaluates a deferred generic
   body, so a comptime-only assertion would prove nothing.

   Two deliberate gaps. `TomlValue` gets none, because the `toml` crate's
   `Value` has none either and TOML has no null — an empty table would be a
   guess, exactly the reason `derive(Default)` refuses enums. `Array(T, N)`
   gets none, because the only array constructor is
   `fill : (fn(comptime(val) : T) -> comptime(Self))` under `T <: Comptime`,
   and `(T <: Default).default()` is not a comptime value; Rust's array
   `Default` needs a runtime element-wise initializer Yo has no spelling for
   yet. `str` also gets none: it has no impls at all today (it is a builtin
   view with intrinsics only) and no empty-`str` constructor.

   **One compiler bug fell out.** Asserting `unit.default() == ()` did not
   compile: a `unit` operand renders as the EMPTY C string, and `_binop`'s
   degraded-render guard reads an empty operand as a failed transpile, so every
   `unit == unit` became a `// Failed to transpile` comment — fatal in `main`,
   and inside a DERIVED `==` an abort()-ing stub. So `derive(Eq)` over a struct
   with a `unit` field shipped a binary that died on its first comparison,
   which is precisely the case the prelude's `impl(unit, Eq(unit))` comment
   claims to serve. Fixed by excluding `unit` from the builtin-inline operator
   routing so it uses the `Eq(unit)`/`Ord(unit)` impls that already existed
   (issues/fixed/unit-operand-renders-empty-so-binop-reports-ftt.md).

   **Encoding — `JsonValue` batteries: DONE (2026-09-09).** The audit asked for
   "`JsonValue` mutation (`insert`/`remove`/`object()`), `is_*`/`as_i64`/
   `as_u64`, `pointer`, integer arms". All but the integer arms are in:
   the six `is_*` predicates, `as_f64`/`as_i64`/`as_u64`, the `object()` /
   `array()` empty constructors, `insert` (returning the REPLACED value, so it
   is `serde_json`'s `Map::insert` and not a silent overwrite) / `remove` /
   `push`, and RFC 6901 `pointer`. `JsonValue` also gains the three traits
   finding 14 says it had none of: `ToString` (the compact text, = `Display`),
   `Clone` (a deep tree — the payloads are `ArrayList`s, i.e. RC handles, so a
   plain copy ALIASES the children) and `Eq`.
   `insert`/`remove`/`push` PANIC on the wrong variant, matching the two
   `Index` impls the file already had; in `serde_json` the variant check is
   `as_object_mut()`, here it is the `is_object()` this PR adds.

   Three things the tests pinned that are easy to get wrong: `Eq` compares
   objects as MAPS (key order is not significant — `serde_json` behaves that
   way under both its map backends), `as_i64` decides "integral" by an exact
   round trip so NaN and ±infinity land in `.None` (2^63 is exactly
   representable as a double, which makes `[-2^63, 2^63)` an exact bound), and
   `pointer` must decode `~1` BEFORE `~0` or `~01` comes out as `/` instead of
   the literal key `~1`.

   **The integer arms are NOT done and are deliberately deferred**: a
   `Number(i64)` variant beside `Number(f64)` changes the parser, both
   stringifiers, `ToJson`/`FromJson` and every match over the enum — a breaking
   change that belongs in a breaking window, not in an additive batch.
   `as_i64`/`as_u64` give callers the integer they actually wanted meanwhile.

   **Two bugs fell out.** `FromStr` turns out to be implemented for only 6 of
   the 13 numeric primitives — `usize` has none, so `token.parse(usize)` does
   not compile (issues/fromstr-missing-on-seven-numeric-primitives.md). And
   writing `Eq` the obvious way — a `_kids_eq` helper comparing children with
   `==`, called from the `Eq` body — produces an abort()-ing stub behind a
   green `yo check`: the helper and the impl body are mutually recursive
   through the impl, and impl fields get no signature-first binding phase the
   way two plain `fn`s do
   (issues/mutual-recursion-between-a-fn-and-a-trait-impl-body.md, with a
   minimal reproducer). `Eq` is therefore ONE self-recursive `_json_eq`, which
   is what `Clone` already did.
   **`## Stability` markers: DONE (2026-09-09).** §1's last row counted eight
   modules without one. `std/http/server` got its marker when the server was
   last touched; the remaining six now have one — `std/async/index`,
   `std/async/channel`, `std/async/mutex`, `std/sync/barrier`,
   `std/sync/semaphore` and `std/gc` (which also gains the module doc it never
   had: what the cycle collector is FOR, and that `tracked_count` counts cycle
   CANDIDATES, since an `Acyclic` type never reaches the collector).

   Writing them settled two rows and surfaced one divergence:

   - `async/mutex.with_lock` **already takes an `io`**, so the §4 row ("either
     takes an `io` so its doc claim becomes true, or drops the claim") is
     satisfied as written — the claim is true today. No change needed.
   - `sync/barrier` and `sync/semaphore` are marked **stable**: both follow a
     named model exactly (the generation barrier; Java/`tokio` counting
     semaphore), and the two properties most likely to be read as provisional
     — unfair acquisition, an uncapped permit count — are deliberate and
     already documented.
   - **`async/channel.try_recv` still returns `Option(T)`** where
     `sync/channel`'s now returns `Result(T, TryRecvError)` (#495). The
     marker names it as the thing that will move; aligning it is a follow-up,
     not a doc change.
   **I/O — the two net address types get their traits, and `TcpStream` gets
   `local_addr` (2026-09-09).** §1's trait-coverage row read "`Eq`/`Hash` on
   0/2 net address types". `IpAddr` and `SocketAddr` now have `Eq`, `Ord`,
   `Hash` and `Clone`, which is what makes a connection table keyed by peer or
   a sorted peer list possible at all; the test asserts exactly that use.

   All four are hand-written rather than derived, for a reason worth recording:
   the order Rust gives these types is NOT the structural one. `Ipv4Addr`
   compares as its 32-bit value and `Ipv6Addr` as its 128-bit one, and every V4
   address sorts before every V6 one (Rust gets that from deriving `Ord` over
   `V4 < V6` in declaration order). `Hash` feeds a one-byte family tag first,
   so a V4 and a V6 address cannot collide by sharing a byte pattern.

   `TcpStream.local_addr` reads the kernel's answer ONCE, at connect / accept
   time, and stores it beside `_peer_addr` — the ephemeral source port and the
   source interface are not in the `connect` argument, and a stored value keeps
   the accessor infallible and symmetric with `peer_addr`. The `getsockname`
   read-back that `TcpListener.bind` and `UdpSocket.bind` each open-coded is
   now one `_read_local_addr` helper.

   Still open in this group: `TcpListener.incoming`, `UdpSocket.recv_from ->
   (n, from)`, `Seek`, `OpenOptions`, `SystemTime`, `StatusCode`, `HeaderMap`,
   `Watcher` `Dispose`, lazy `read_dir`, byte bodies in HTTP.

   **`TcpListener.incoming` is deferred, and this is why.** Rust's `incoming()`
   is a BLOCKING iterator of `io::Result<TcpStream>`. Yo's `accept` is
   `Impl(Future(TcpStream, IoExn))`, and there is no `Stream` trait — no async
   analogue of `Iterator` — for an iterator of futures to implement. Giving
   `incoming` an `Iterator` that blocks the event loop per element would be
   worse than not having it (a blocking await inside a task nests the loop and
   deadlocks). The row wants an async-iteration abstraction first; it is a
   language/std design question, not a missing method.
   **`f64`/`f32` non-finite constants: DONE (2026-09-09), unblocked by the
   v0.2.29 seed.** `INFINITY`, `NEG_INFINITY` and `NAN` are the last three
   names `std/math` was missing. They had to wait for a seed because the
   v0.2.28 compiler emitted a non-finite float constant as the invalid C
   literal `inf.0` (issues/fixed/comptime-float-infinity-emits-invalid-c.md,
   fixed in #487 and therefore first present in a seed at v0.2.29), and `std/`
   must build under the seed.

   None of the three has a token, so each is spelled as the thing that produces
   it: an OVERFLOWING literal (`f64(1.0e400)`) for the infinities and `∞ - ∞`
   for the NaN. Both alternatives were tried and rejected against the actual
   compiler: `0.0 / 0.0` is refused outright ("Division by zero in comptime
   float operation: __yo_comptime_f64_div"), and `x * y - x * y` is fused into
   an FMA by `-ffp-contract=on` and evaluates to `-inf` rather than NaN.

   The tests do not stop at `is_infinite()`/`is_nan()`. They assert
   `INFINITY > MAX`, `NEG_INFINITY < MIN`, `NEG_INFINITY == -INFINITY`, that
   NaN is unequal to ITSELF (the reason `is_nan()` exists), and that arithmetic
   on the constants behaves — `inf + 1`, `inf * -1`, `1 / inf`, NaN
   propagation. That last group is the one that would have caught `inf.0`:
   a constant that never reaches the C compiler correctly cannot be added to.

   `std/math` is now marked stable with ONE remaining gap: the `f32`
   transcendentals C has no single-precision entry point for.

   **A second compiler bug fell out, Windows-only.** The codegen recognised a
   non-finite float raw by string EQUALITY against `"nan"` / `"-nan"`, but the
   raw is the HOST C library's `%g` output and the libraries disagree: the MS
   CRT spells the indefinite NaN `-nan(ind)`. So `f64.NAN` emitted
   `-nan(ind).0` on Windows and clang read the payload as an identifier
   ("use of undeclared identifier 'ind'; did you mean 'bind'?") while macOS and
   Linux stayed green. Matched by prefix now
   (issues/fixed/msvc-nan-spelling-escapes-the-non-finite-float-match.md).
   The same divergence is visible from Yo — `f64.NAN.to_string()` differs by
   platform — which is filed separately as a std portability defect
   (issues/float-to-string-is-platform-dependent-for-non-finite-values.md);
   it also decides what `json_stringify` should do with a NaN, since JSON has
   no non-finite literal.
   **Encoding — `Url.join` / `query_pairs` / `path_segments`: DONE
   (2026-09-09).** §4's first Encoding row, including the parenthetical that
   explains why it mattered: "http hand-rolls redirect resolution because
   `join` is missing".

   `join` is RFC 3986 §5.3 in full — a `_split_ref` that decomposes any URI
   reference into the Appendix-B five components, `_remove_dot_segments`
   (§5.2.4), `_merge_paths` (§5.2.3), and recomposition handed back to the ONE
   parser rather than a second copy of the authority rules. All 20 §5.4.1
   normal examples and all 12 §5.4.2 abnormal ones are tests, plus the three
   cases the RFC's table does not cover but a reader will ask about: an empty
   interior segment survives, a colon after the first slash is not a scheme,
   and a colon before any slash is.

   `http/client._resolve_location` now calls it, which fixed three real
   redirect bugs the paste-the-origin version had (each verified against the
   old code before the claim was written down): `../x` was pasted VERBATIM
   instead of climbing, a protocol-relative `//host/p` was treated as an
   absolute path on the current host, and a `Location` of `?q=1` replaced the
   path with the base's directory instead of keeping it. The `../` case has an
   end-to-end loopback test; the other two are pinned directly on `join`.

   `query_pairs` follows the `application/x-www-form-urlencoded` rules a
   `?a=b&c=d` query actually obeys — `+` is a space DECODED BEFORE the percent
   escapes (the other order turns an encoded plus into a space), only the first
   `=` splits, a bare key has an empty value, and order and duplicates survive.
   `path_segments` is `.None` for a URL that cannot be a base, as Rust's is.
   Both decode LOSSILY: `percent_decode` returns a `Result`, which is right for
   a caller decoding one value on purpose and wrong for an accessor over a URL
   that already parsed, so a malformed escape yields the raw text.

   **One compiler bug fell out**, and it is the reason `query_pairs` could not
   be written at first: `ArrayList(Tuple(String, String))` did not compile at
   all. Tuples were emitted as ANONYMOUS C structs, which cannot be
   forward-declared, so a container holding a POINTER to a tuple named a type C
   had not seen — `unknown type name '__yo_t2'`. Fixed by giving tuples a named
   struct tag like every other struct type
   (issues/fixed/tuple-type-has-no-forward-declaration.md).

   Still open in Encoding: TOML floats/arrays/dates/inline tables/escapes/
   comments/serializer, `EncodingError` offsets, regex Rust-shaped names,
   `GlobPattern.new -> Result` + filesystem `glob()`, the module-prefix stutter,
   and `Url.set_*`.

   **`FromStr` renamed to `FromString` (2026-09-09).** The trait's parameter is
   a `String`, and its own doc comment said so one line above the signature —
   the name was a mis-transliteration of Rust's. Rust's name is ACCURATE
   (`fn from_str(s: &str)` takes a `&str`) and the pattern behind it is "name
   the trait after the type it converts FROM"; applying that pattern in Yo
   gives `FromString`.

   The alternative — make it take a `str` so the name becomes true — is not
   available. `as_str()` was deleted in the slice rework, no method in
   `std/string/string.yo` returns `str`, and `String.parse(T)`'s receiver IS a
   `String`, so `String` is the only parameter the trait can take.

   Two other sites made the same mistake and are swept with it:
   `log.level_from_str(name : String)` → `level_from_string`, and
   `HttpMethod.from_str(s : String)` → `from_string`. `std/imm/string.yo`
   already had `from_string(s : String)`, so the tree was inconsistent with
   ITSELF, not only with Rust. Rust CITATIONS in doc comments
   (`core::str::FromStr`, `i64::from_str`, `from_str_radix`) keep Rust's
   spelling — they name Rust's API, not Yo's.

   Breaking, and deliberately without a compatibility alias: a
   `FromStr :: FromString` alias keeps `where(T <: FromStr)` working but NOT
   `from_str : …` inside an impl, because a field name is part of the trait.
   A half-bridge covering one of the two ways a trait is used is worse than a
   clean rename announced in the release notes.

   Surfaced one row for later: `HttpMethod.from_string` returns `Option`, not
   `Result` — a D12 violation independent of the name, and an error-type design
   question rather than a rename
   (issues/httpmethod-from-string-returns-option-not-result.md).
5. **Freeze** — re-run the five measurements; a module freezes only when its
   group's list is empty.

Per-group raw findings — every file:line, the Rust counterpart for each item,
and the doc-coverage tables — are in `plans/STD_API_STABILIZATION_FINDINGS.md`.
This document keeps the decisions and the ranked list so it stays readable.
