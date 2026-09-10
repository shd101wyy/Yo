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
  `derive(Error)` with per-variant format strings **LANDED 2026-09-09** —
  `derive(JsonError, Error(.UnexpectedEnd => `unexpected end of input`, …))`
  emits `ToString` AND `Error` from one declaration, so an error enum no longer
  needs two hand-written blocks. The message is ORDINARY YO spliced into the
  arm that binds the payload, so `${pos}` is the variant's own field rather
  than thiserror's positional `{0}`. The rule builds the two-trait
  `impl(T, ToString(…), Error())` directly instead of via `ctx.make_impl`,
  which wraps exactly one trait body; generic error enums are out of scope for
  the same reason (no std error type is generic).
  **Messages go in DECLARATION ORDER**, each verified against the variant it
  lands on, so a renamed/added/removed/reordered variant is a compile error.
  Keyed lookup — match each message to its variant by name, any order — is what
  this wanted to be, and `Expr` equality (`ComptimeEq` / `__yo_expr_eq`) makes
  it expressible; composing it inside a rule hit a diagnostics bug where the
  rule's real error was replaced by `derive rule function failed` or discarded
  entirely (`check` and `compile` both exiting 0). **That bug is now FIXED**
  (`issues/fixed/derive-swallows-the-rule-error.md`), so the only thing still
  holding the declaration-order constraint is the SEED GATE — `std/` cannot
  rely on the fixed compiler until the seed ships it. Lift it one release
  later; no call site changes, because declaration order IS a valid keyed
  list.
  **All thirteen std error enums are migrated** — `JsonError` with the rule
  itself, then `TimeoutError`, `CryptoError`, `TlsError`, `CsvError`,
  `EncodingError`, `RegexError`, `IoError`, `NetError`, `UrlError`,
  `DateTimeError`, `HttpParseError` and `HttpError` in the follow-up. Every
  rendered message is unchanged and all thirteen now-redundant
  `impl(T, Error());` lines are gone.
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
| `Seek` trait | ~~`SeekFrom` exists (`std/fs/types.yo:66`); there is no `Seek` TRAIT~~ — **LANDED 2026-09-09**, `std/io/index.yo` `Seek(From)`, implemented by `File` |
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
regex naming, `glob()`. I/O — `Watcher`
`Dispose`, `SocketAddr` `Eq`/`Hash`,
`TcpStream.local_addr` (it is on `TcpListener`), `TcpListener.incoming`. Core — **all of it**: every `checked_/wrapping_/
saturating_/overflowing_`, `abs/pow/clamp/count_ones/leading_zeros`, every
`f64`/`f32` method and const (only raw `libc/math` today), `Error.is`,
`ErrorChain`, `Context`, `derive_rule(Error)`, `black_box`, log `Sink`/`YO_LOG`,
`thread_rng`. Concurrency — `Thread` is NOT generic and `join -> unit`
(`std/thread.yo:61,78`), so **D18b is still open**; `Sender`/`Receiver` split,
`spawn_blocking` absent (`Mutex.try_with_lock`,
`Cond.wait_timeout` and `RwLock.try_with_read`/`try_with_write` all LANDED
2026-09-10, once v0.2.30 shipped the runtime primitives as the seed)
(`Semaphore.with_permit` and `TryRecvError` were LISTED HERE IN ERROR — both
landed, in `std/sync/semaphore.yo:148` with a test at
`tests/sync/semaphore.test.yo:318`, and in `std/sync/channel.yo` /
`std/async/channel.yo`; re-verified 2026-09-10. `interval` landed 2026-09-10);
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

**Encoding.** Verified against the code 2026-09-09 — LANDED:
`Url.join`/`query_pairs`/`path_segments`; `JsonValue` mutation
(`insert`/`remove`/`object()`), `is_*`/`as_i64`/`as_u64`, `pointer`, integer
arms; TOML values; `GlobPattern` + filesystem `glob()`. STILL OPEN: module-prefix
stutter (`json_parse` → `json.parse` …). `Url.set_*` and `EncodingError`
offsets **LANDED 2026-09-09** — described below.

**`Url.set_*` — LANDED 2026-09-09, and every setter is FALLIBLE.**

`set_scheme`, `set_host`, `set_port`, `set_path`, `set_query`, `set_fragment`,
`set_userinfo`. All but `set_port` return `Result(unit, UrlError)`, and that is
not ceremony: `Url.parse` rejects any byte outside RFC 3986 §2 as a SECURITY
boundary — a raw CRLF in a path flows through `Url.path()` into
`HttpRequest`'s request line and splits one HTTP request into two — so a setter
that skipped the check would be a hole straight past the parser. The offset of
the first offending byte comes back in `UrlError.InvalidCharacter(pos)`, the
same shape and the same convention `parse` already uses, so a caller handles
one error whether the URL came from text or from a setter.

Each setter also rejects the delimiters that would RELOCATE its component,
and the sets differ per component because the grammar does: a `/` is legal in
a path and a query but ends a host; a `?` is legal in a query but starts one
inside a path; the fragment is last, so nothing can follow it and every URI
byte is legal there. A forbidden byte does not corrupt the value — it silently
changes what the next parse reads — which is why these reject rather than
percent-escape: escaping would change what the caller asked for without saying
so.

Three shapes get their own guard because `to_string` would otherwise render
something that re-parses differently: a bare IPv6 host (its colons read as a
port, which is why RFC 3986 §3.2.2 has the brackets), a relative path while a
host is set (`http://host` + `x` renders `http://hostx`), and a path beginning
`//` with no host (renders `scheme://…` and re-parses as an authority).
`set_port` is infallible because every `u16` is a legal port, including 0.

**`EncodingError` offsets — LANDED 2026-09-09.** Every variant that can name a
position now carries `pos`, plus a `pos() -> Option(usize)` accessor.
`InvalidChar(ch, pos)`, `InvalidLastSymbol(ch, pos)`, `OddLength(len)`,
`InvalidLength(len)`. Without the offset a caller decoding a 4 KiB blob learned
only that one byte somewhere was wrong — not enough to report, highlight or
skip past, and the character alone does not say WHICH occurrence of it.
(Rust's `base64::DecodeError` carries the same offset for the same reason.)

The new `UnpairedSurrogate(code_unit, pos)` replaces a wrong value, not just a
thin one: all three surrogate faults in `utf16_to_utf8` reported
`InvalidChar(u8(0))` — an offending character of NUL — because a UTF-16 code
unit is 16 bits and `InvalidChar`'s `ch` is a `u8`, so the variant could not
carry it at all. Its `pos` is an index in CODE UNITS, not bytes, because that
is what the input is.

The field is spelled `code_unit` rather than `unit` because a field named after
a builtin type breaks the unhygienic derived body with a confusing
`Argument count mismatch: expected 1, got 0` — filed as
`issues/derive-body-field-name-collides-with-a-builtin-type.md` with a
reproducer. regex Rust-shaped names **LANDED 2026-09-09** —
`test` → `is_match`, `exec` → `find`, `match_all` → `find_all`, and the
two-argument `new(pattern, flags)` split into a one-argument `new(pattern)`
(what `compile` used to be, now deleted) plus `new_with_flags(pattern, flags)`,
so the common flagless call no longer spells an empty string and there is one
name per shape. `find_iter` already had its Rust name. There is deliberately
NO separate `captures`: Rust splits `find` (span) from `captures` (span +
groups) because the first is cheaper, while Yo's `RegexMatch` always carries
its groups, so a second method would add nothing — `find`'s doc says so.
`search() -> Option(usize)` is REMOVED rather than renamed: it returned the
first match's byte offset, which is `find(input)`'s `RegexMatch.index()`, so it
was a strictly-less-informative duplicate carrying a JavaScript name. Only one
non-test caller existed in the whole tree (`src/main.yo`'s
`--test-name-pattern`).

**I/O.** Verified against the code 2026-09-09 — LANDED:
`Stdout.write_string`; `Reader.read_exact`; lazy `read_dir`;
`Metadata.modified`; `SocketAddr`/`IpAddr` `Eq`/`Hash`/`Ord`/`Clone` + `parse`;
`TcpStream.local_addr`; `TcpListener.incoming`. STILL OPEN: HTTP keep-alive —
its FRAMING half landed 2026-09-10 (described just below), the pooling client
is the remaining piece. (`Child` stdin/stdout/stderr as `Reader`/`Writer`
handles and `Watcher` `Dispose` also landed 2026-09-10, described below.)
(`Seek`, `OpenOptions`, `SystemTime`, `IpAddr.parse_v6`,
`UdpSocket.recv_from -> (n, from)`, `StatusCode` and `HeaderMap` all landed
2026-09-09 — described just below.)

**`Child` pipe handles + `Watcher` `Dispose` — LANDED 2026-09-10.**

`Command.spawn`'s `Child` now yields the parent ends of its pipes as typed
handles: `take_stdin() -> Option(ChildStdin)` (a `Writer`),
`take_stdout() -> Option(ChildStdout)` and
`take_stderr() -> Option(ChildStderr)` (both `Reader`s). That is what puts a
child's streams inside `std/io`'s surface — `write_all`, `read_to_string`,
`read_exact`, `BufReader.lines` — instead of the three bespoke methods
(`write_stdin`, `read_stdout_to_end`, `read_stderr_to_end`) that were the only
way in. Those stay, and now say they throw `BadFileDescriptor` once the fd has
been taken.

Three shape decisions:

- **Taking MOVES the fd** out of the `Child` (`_stdout_fd = .None`), so `wait()`
  no longer closes it and there is exactly one owner. A second `take_stdout()`
  is `.None`, which is also how "this stream was not `Stdio.Piped`" reads —
  the same answer to the same question ("can I have that stream?").
- **`ChildStderr` is a distinct type** from `ChildStdout` despite being
  structurally identical, for Rust's reason: the type says which stream you
  are holding.
- **`close` sets its flag INSIDE the async body**, after the close, mirroring
  `File.close`. A future that is created and never awaited must leave the
  handle closeable, or `dispose` would skip an fd that is still open.

Each handle has a `Dispose`, so dropping a `ChildStdin` delivers the EOF the
child is waiting for without an explicit `close`.

`Watcher` gained the `Dispose` it never had, and the missing one was worse than
a leak. `watch` registers its callback with a **raw, non-owning** pointer to
the watcher (`unsafe.cast(w, *u8)`), so a watcher dropped while active left the
event loop calling `_on_fs_event` into freed memory — reading `w._active` and
then pushing into a freed `ArrayList` — on top of leaking the backend's
`__yo_fs_event_t` and its inotify/kqueue descriptor. Linux caps inotify
instances per user at 128 by default, so the leak alone stopped a
watcher-creating loop from watching anything. `dispose` delegating to the
already-idempotent `close()` is what makes the non-owning `user_data` sound:
the callback cannot outlive the object, because the object's teardown removes
it. `close` moved from `inout(self)` to `self : Self` to allow that delegation
— every other closeable in `std/` already spelled it that way, and `Watcher`
is a `ref(struct)`, so the field writes are unchanged.
(`issues/fixed/a-dropped-watcher-leaves-the-event-loop-calling-freed-memory.md`)

**HTTP keep-alive, the framing half — LANDED 2026-09-10.**

Connection reuse is blocked on one thing before any pool exists: a single
`read` can return bytes belonging to TWO messages, and framing the second by
"whatever arrives next" is request/response smuggling (RFC 9112 §11.2) — and a
heisenbug, because it only shows up when the peer's writes coalesce.
`read_http_message` already truncated at the message boundary (that was
`_message_upto`, added for exactly this reason) but **discarded** the excess,
which is correct only because its connection was about to be closed.

`read_http_message_buffered(stream, max_bytes, is_request, carry, io)` is the
reusable form: `carry` comes in holding whatever the previous message left
behind and goes out holding whatever this one left behind. One list per
connection. `read_http_message` stays as a wrapper that passes a fresh list, so
no existing caller changes.

Three supporting pieces, each needed by the above:

- **`Dechunk.Done` carries an `end`.** A chunked body's boundary is the index
  just past its terminating CRLF, and nothing recorded it — the decoder only
  handed back the decoded data.
- **The stopping decision moved into `_frame_status`.** It was inline in the
  read loop, which meant a keep-alive read could not ask it BEFORE its first
  read — and asking first is not an optimization: a message already complete in
  the carried bytes must not cost a read, because that read would block until
  the peer sent something it has no reason to send.
- **`HttpResponse.version`.** The status line's version was parsed and thrown
  away, and reuse turns on it: an `HTTP/1.0` response without
  `Connection: keep-alive` ends its connection (RFC 9112 §9.3). It is kept for
  the same reason `status_text` is — a proxy passes it through — and
  `to_string` now emits it, so a parsed response round-trips.

Tests drive a SCRIPTED reader rather than a socket (`tests/http/wire.test.yo`):
the whole point is what happens when one read spans two messages, and a socket
cannot be made to do that on demand. The reader counts its calls, so "did this
cost a read?" is an assertion rather than an assumption.

Still open for the client: the pool itself. The intended shape is an
`HttpClient` object that OWNS its idle connections (Rust's `reqwest::Client`
model) rather than a module-global — explicit lifetime, `Dispose` closes the
idle set, and no global mutable state in `std/`. The free `fetch`/`fetch_with`
keep their current one-shot behaviour. Server-side keep-alive needs a
prerequisite of its own that the client does not: an IDLE TIMEOUT. `serve` is
one-connection-at-a-time, so a client that holds a keep-alive connection open
and sends nothing would wedge the server — which is why the server half is not
simply "loop until the client closes".

**`BITS` as an associated constant — LANDED 2026-09-10, and it retires a
documented blocker.**

The bit-battery banner in `std/prelude.yo` said a width-dependent operation
"cannot" be a `where(T <: Integer)` blanket impl because "Yo has no `T.BITS`
associated constant". That was a gap in `std/`, not in the language: `MIN` and
`MAX` are ordinary associated constants declared in an `impl` (`MIN : u8(0)`),
and a blanket body already reads `T.MIN`. So `BITS : u32(8)` sits beside them
for the eight fixed-width types, and beside `_USIZE_BITS` for `usize`/`isize`
— which is where their target-dependent width is already decided.

With it, the six shift methods (`checked_shl`/`shr`, `wrapping_shl`/`shr`,
`overflowing_shl`/`shr`) are ONE blanket impl rather than sixty per-type
entries. `checked_shl` is not a convenience: a shift by the width or more is
undefined behaviour in C, so the count must be rejected BEFORE the shift is
performed, which is exactly what the `.None` arm does.

`unsigned_abs` is ALSO one blanket impl, over a new `UnsignedCounterpart`
trait carrying an ASSOCIATED TYPE (`Unsigned : Type`), so the body can name
its own result:

```rust
UnsignedCounterpart :: trait(id := "UnsignedCounterpart", Unsigned : Type);
impl(i8, UnsignedCounterpart(Unsigned : u8));
…
impl(
  generic(T : Type),
  where(T <: (Integer, SignedInteger, UnsignedCounterpart)),
  T,
  unsigned_abs : (fn(self : T) -> T.Unsigned)(T.Unsigned(self.wrapping_abs()))
);
```

**It was first written five times, once per signed type, on the belief that
"Yo has no associated type to name the unsigned type of the same width". That
belief was wrong.** Associated types are a documented Yo feature —
`docs/en-US/DESIGN.md` specifies `Iterator`/`IntoIterator` in terms of
`Item : Type`, `Self.Item` and `Trait(Item := X)` — and a probe confirmed the
exact shape needed works today: an associated type in a RETURN position,
supplied per-type, consumed from a blanket impl, and used as a constructor.
The five copies were replaced with one.

The same correction applies to the per-type bit batteries (`count_ones`,
`leading_zeros`, `rotate_left`, …). They need the receiver widened to `u64`
THROUGH its own unsigned type (`i8(-1).count_ones()` is 8, not 64), and
`T.Unsigned` now names that type — so collapsing those ten blocks into one
blanket impl is a REFACTOR nobody has done, not a language limitation. The
banner says so instead of blaming the language.

**The lesson, for the rest of this campaign:** "Yo has no X" in a comment is a
claim about a moving target, and three of them turned out to be false in one
day (`T.BITS` as an associated constant, associated types, and
`async/channel.try_recv`'s shape). Probe before working around.

One thing this batch had to get right twice: `-1` cannot be spelled
`T(0) - T(1)` in a blanket body. On an unsigned instantiation that is a
comptime overflow and a HARD compile error (`Result -1 exceeds u8 range`), and
it fires even from an arm the unsigned type would never take. The file's
existing idiom — `rhs < T(0) && (T(0) - rhs) == T(1)`, which short-circuits
before the subtraction — is what the five `MIN / -1` guards use.

**`Seek` + `OpenOptions` + `SystemTime` — LANDED 2026-09-09, and the shapes
each had a reason.**

`SystemTime` is a SECOND clock, deliberately not interconvertible with
`Instant`: `Instant` reads `CLOCK_MONOTONIC` (no epoch, never steps, only
differences mean anything), `SystemTime` reads `CLOCK_REALTIME` (anchored at
`UNIX_EPOCH`, and steppable by NTP or by hand). `duration_since` therefore
returns `Result(Duration, SystemTimeError)` — Rust's shape — because a
backwards step is a real outcome, not a bug to swallow. All of its arithmetic
stays on the `(secs, nanos)` PAIR: converting either side to a single `i64`
nanosecond count overflows past year 2262, and signed overflow is UB in C.
Every constructor normalizes `nanos` into `[0, 1e9)` with a FLOOR second, so one instant has one
representation — without that, `(-1, -4e8)` and `(-2, 6e8)` are the same
timestamp and compare unequal under the field-wise `Eq`/`Ord`.

`Metadata.modified`/`accessed`/`status_changed` now return `SystemTime` built
from `statx`'s seconds AND nanoseconds. The seconds-only `*_time` accessors are
kept (a caller that wants the raw field should not have to go through a struct)
and pinned by a test asserting `modified_time() == modified().as_unix_secs()`.

**A filesystem timestamp and `CLOCK_REALTIME` are different clock domains**, so
an mtime can sit a hair AHEAD of a later `SystemTime.now()`. Emscripten's MEMFS
put it 64 ns ahead, which failed a first version of the test that asserted the
ordering ("mtime must not be in the future") — no OS promises that ordering,
only that the two readings are close. The test now bounds the skew in either
direction. It is also a live demonstration of why `duration_since` returns a
`Result`: the 64 ns showed up as `SystemTimeError.EarlierThan`, exactly the
outcome a silent `Duration.zero()` would have hidden.

The `Seek` trait is SYNCHRONOUS while `Reader`/`Writer` are async, because
moving a position is arithmetic on a handle's own state: `File`'s reads and
writes are positional (`pread`/`pwrite`), so its descriptor sits at offset 0
forever and `File.seek` never touches it. It is parameterized over the
reference-point type (`Seek(From)`) rather than re-declaring `SeekFrom`, so
there is one spelling of "from where" in the tree. It has NO `rewind`, unlike
Rust: every absolute move needs a `From` VALUE naming the beginning, and a
trait generic over `From` cannot name one — a `rewind(self, from, exn)` default
would make the caller pass the very thing `rewind` exists to hide, so the
convenience is inherent on `File` instead.

`OpenOptions` is a plain value struct with FUNCTIONAL setters (each returns a
new value), not the `ref(struct(...))`-with-mutation shape `Command` uses: a
flag bag needs no allocation or refcount, and an immutable builder lets one
base be reused for several opens. It exists because `OpenMode`'s five variants
cannot express read+append, create-without-truncate, or read+write+create, and
growing that enum combinatorially is the wrong answer. `to_flags()` returns
`Result(i32, String)` and REJECTS the four combinations POSIX does not
diagnose — no access mode at all, `truncate` without write access, `truncate`
with `append`, `create` without write access — because `open(2)` quietly
ignores whichever flag does not apply and hands back a file that behaves
differently from what was asked. `File.open_opts` raises a rejection as a
`Context` over `IoError.InvalidInput`, so `to_string()` names the contradiction
while `source()` still reports the kind Rust would report. Note the access mode
is a VALUE, not a bit set (`O_RDONLY` is 0), so it is chosen rather than OR-ed.

Coverage: 9 `SystemTime` tests in `tests/time/instant.test.yo` (14/14), 2
timestamp tests in `tests/fs/metadata.test.yo` (10/10), and 10 in
`tests/fs/file.test.yo` (29/29) covering flag mapping, each rejected
combination, setter non-mutation, read+append, create-without-truncate,
`create_new` on an existing path, the `Context` message, `rewind`, and a
generic function bounded on `Seek(SeekFrom)` — the last one being the only
thing that proves the impl is registered rather than the inherent method being
picked up.

**`IpAddr.parse_v6` + `UdpSocket.recv_from` + HTTP `StatusCode`/`HeaderMap` —
LANDED 2026-09-09.**

`IpAddr.parse_v6` takes all three RFC 4291 §2.2 forms — the full eight groups,
one `::` compression run, and a trailing dotted-quad for the last 32 bits
(which is how an IPv4-mapped address is written). Hex is case-insensitive on
input. It REJECTS, each with its own message: two `::` runs, more than eight
groups, a group over four hex digits, an empty group that is not part of a
`::`, a single leading or trailing `:`, a non-hex byte, a dotted-quad that is
not itself a valid IPv4 address, a `::` in an address that already spells eight
groups (RFC 5952 §4.2.2), and a zone id (`%eth0` names an interface, not an
address, and `IpAddr` has nowhere to put it). `IpAddr.parse` dispatches on
whether the text contains a `:` — exact, because a `:` cannot appear in an
IPv4 address and must appear in an IPv6 one, so a malformed address reports the
error for the family it was clearly meant to be rather than the second parser's
confusing complaint.

`UdpSocket.recv_from` now resolves to `(usize, SocketAddr)`. It used to take
`src_addr : *u8, src_addr_len : *u32` out-params that every caller had to
`malloc`, pre-set to 128, pass in, decode with `IO_tcp.get_*` and free — a C
signature in a Yo API, handing the address back undecoded. Two pointer-free
conveniences came with it, `recv_bytes` and `recv_from_bytes`: `send_to`/`send`
have always taken an `ArrayList(u8)` while every RECEIVE took a `*(u8)`, and
raw pointers are unavailable in safe code, so a program without
`pragma(Pragma.AllowUnsafe)` could SEND a datagram and not read one. The
duplicated `_make_sockaddr` in `std/net/udp.yo` is gone — `tcp.yo`'s is
exported and shared now, which is what the byte-for-byte copy had cost: the
hardcoded-`::1` bug (C2) had to be fixed twice.

HTTP `StatusCode` is a `u16` newtype with the class predicates
(`is_informational` … `is_server_error`, plus `is_error` spanning 4xx+5xx), the
registered reason phrases, and 22 named codes as nullary constructors — not
enum variants, because the set is OPEN: a server may send a registered code the
list does not carry, and an enum would have to reject or box it. `u16` because
RFC 9110 §15 fixes the range at three digits, so a status is never negative,
which the old `i32` allowed. `HttpResponse.status_code : i32` became
`HttpResponse.status : StatusCode`; `status_text` stays, because the reason
phrase is advisory and a proxy must be able to pass the peer's through while
`status.reason()` gives the registered one.

`HeaderMap` replaces `ArrayList(HttpHeader)` on both messages. It gives the two
things HTTP requires and a `HashMap(String, String)` cannot: names compare
case-insensitively (RFC 9110 §5.1) while being STORED as written, since that is
what goes on the wire; and a field may repeat with the order significant
(`Set-Cookie` always does), so it is an insertion-ordered multimap backed by a
list. `insert` replaces every value for a name, `append` adds one — the split
Rust draws, and the reason `set_host` used to put two `Host` lines on the wire.

Three bugs fell out of the rework, all pinned by tests: `parse_response`
accepted a status outside 100–599, producing a response whose every class
predicate answered false; it REJECTED a status line with no reason phrase,
which RFC 9112 §4.1 makes optional; and it rebuilt the body by splitting the
whole message on CRLF and re-joining the tail one concatenation at a time —
quadratic in the body size, and a `substring` over a UTF-8 continuation byte
panics. The body is now sliced as BYTES on the CRLFCRLF boundary, the same way
`parse_request` already was. (The "byte bodies broken client-side" row was
therefore only half stale: `parse_request` had been fixed, `parse_response` had
not.)

Coverage: 6 new `parse_v6`/`parse` tests (`tests/net/addr.test.yo`, 26/26,
including 16 malformed inputs and a `to_string` round-trip), 3 new UDP receive
tests (`tests/net/udp.test.yo`, 10/10), and 10 new tests in
`tests/http/http.test.yo` (35/35) over the range check, the class boundaries
(199/299/399/499), the reason phrases, case-insensitive lookup, verbatim
storage, `append` vs `insert`, `remove`'s count, the `entries` snapshot, the
`set_host` duplicate, a repeated `Set-Cookie` through the parser, a missing
reason phrase, an out-of-range code, and a binary body with an embedded CRLF.

**Core.** `checked_/wrapping_/saturating_/overflowing_` on every integer
(LANDED), `clamp/min/max` (LANDED), `checked_abs`/`checked_pow` (LANDED);
the BIT batteries **LANDED 2026-09-09** — `count_ones`, `count_zeros`,
`leading_zeros`, `trailing_zeros`, `leading_ones`, `trailing_ones`,
`rotate_left`, `rotate_right`, `reverse_bits`, `swap_bytes` on all ten integer
types, plus `is_power_of_two` / `next_power_of_two` /
`checked_next_power_of_two` on the unsigned five. Written once over `u64` and
delegated per-type with the width as a literal, because Yo has no `T.BITS`
associated constant and a single `where(T <: Integer)` blanket therefore
cannot express a width-dependent operation (this is also how Rust does it —
its macro pastes the width in). The signed types bit-cast to their same-width
unsigned partner: Yo's integer conversions are two's-complement
bit-preserving, so the cast to `u64` must go THROUGH `u8`/`u16`/`u32` or sign
extension adds ones above the receiver's width — `i8(-1).count_ones()` is 8,
not 64, and a test pins that at every width. `usize`/`isize` derive their
width from `usize.MAX` instead of hardcoding 64, because it is 32 on wasm32.
The private SWAR `popcount` in `std/imm/map.yo` is deleted in favour of
`u32.count_ones()`. **That "still open" list was STALE and is now empty.** Re-measured against the
code 2026-09-10: `abs`, `signum`, `pow`, `abs_diff`, `div_euclid`,
`rem_euclid`, `midpoint`, `isqrt` and the byte conversions were all already
there — `abs`/`signum` under the `SignedInteger` marker the note said they
wanted, the byte conversions per-type. What was genuinely missing is now in
(2026-09-10): `wrapping_pow`, `overflowing_pow`, `wrapping_div`,
`wrapping_rem`, `saturating_div`, `overflowing_neg`, `checked_div_euclid`,
`checked_rem_euclid`, `ilog2`, `ilog10`, `ilog`, the six shifts, and
`unsigned_abs`. See the `BITS` note below.
The `f64`/`f32`
methods and consts (`sqrt/abs/floor/ceil/round/trunc/is_nan/is_finite/
is_infinite/signum/min/max/hypot/exp/ln/sin/EPSILON/INFINITY/NAN`) are all
LANDED in `std/math.yo` — the "today only raw `libc/math`" note above is a
snapshot from before that work. Verified against the code 2026-09-09 — also LANDED: `Error` `is(T)`
(the free `error_is`), `Context(msg, source)`, `Default` across the type set
(#500), `bench` `black_box`, and `log`'s `Sink` trait + `YO_LOG`. The integer arithmetic
batteries **LANDED 2026-09-09**: `pow`/`saturating_pow`, `checked_neg`,
`wrapping_mul`/`overflowing_mul`, `div_euclid`/`rem_euclid`, `midpoint`,
`isqrt` in the `where(T <: Integer)` blanket; `abs`, `signum`, `wrapping_neg`,
`wrapping_abs` behind a new `SignedInteger` marker (Rust omits `abs`/`signum`
on unsigned types and so do we); `abs_diff` and
`to_be_bytes`/`to_le_bytes`/`from_be_bytes`/`from_le_bytes` per-type, because
`abs_diff` returns the receiver's UNSIGNED partner and the conversions return
an `Array(u8, N)` sized by its width — neither is nameable from a blanket.
`usize`/`isize` get `abs_diff` but deliberately NO byte conversions: N would
be the target pointer width and a type-level size cannot be derived the way
`_USIZE_BITS` derives a value, so hard-coding 8 would be silently wrong on
wasm32. `downcast` is now DOCUMENTED (2026-09-09) in
`docs/{en-US,zh-CN}/DYN_DESIGN.md` — the `Option(T)` result, the single
pointer-compare against the vtable's `__yo_type_id`, the owned/RC'd result, the
box-unwrapping for value targets, and the statically-`.None` case for a target
no `dyn()` in the program ever wraps.
**`ErrorChain` and `root_cause` are BLOCKED on a compiler defect, not on
design** —
`issues/self-trait-in-a-return-type-loses-the-trait-on-an-erased-receiver.md`.
Both must store the result of `source()` as an `AnyError`, and on a
`Dyn(Error)` receiver that result's static type has lost the `Error` trait:
`Given: dyn((source : fn(...) -> Option(dyn( + ToString))) + ToString)` against
`Expected: dyn(Error + ToString)`. The VALUE and the vtable are correct —
`.to_string()` on it renders the cause — so a caller can follow one link and
print it, but never store, re-erase, `downcast` or re-throw it. Spelling
`Dyn(Error)` instead of `Dyn(SelfTrait)` is not available either: `Error` is
unbound inside its own definition. `rand`
batteries — **LANDED 2026-09-09**: every range-taking API in std is now
`Range`-typed (`rng.range(i64(1) .. i64(7))`, `random_range(a .. b, exn)`,
`m.range(k1 .. k2)`), so the half-open bound is visible at the call site
instead of remembered; `Rng` gained `range_inclusive`, `next_bool` and
`from_entropy`; `crypto/random.random_range` now PANICS on an empty range
like `Rng.range` did, instead of returning `start` — a value that was never
in the range (`BTreeMap.range` keeps yielding an empty iterator, because "no
elements" IS an answer where "no number" is not). `random()`/`thread_rng`
became `rand_u32`/`rand_u64`/`rand_f64`/`rand_bool`/`rand_below`/`rand_range`/
`rand_range_inclusive` over a process-global generator, lazily seeded from OS
entropy and serialized behind a `Mutex`. It is deliberately NOT called
`thread_rng`: Yo has no thread-local storage, so per-thread generators are
not expressible and the name would promise state it cannot deliver — the docs
say to take an own `Rng.from_entropy()` in a hot loop instead.

**Concurrency.** Verified against the code 2026-09-09 — LANDED:
`Thread(T).spawn` + `join() -> T` (D18); `Semaphore.with_permit`;
`try_recv -> TryRecvError{Empty, Disconnected}` (#506). STILL OPEN:
`Sender`/`Receiver` split with auto-close on last sender; waker-based
`yield`/`async channel`/`async mutex` instead of 1 ms timer polls;
`async/mutex.with_lock` either taking an `io` (so its doc claim becomes true)
or dropping the claim; `Once.call` rewritten over `Mutex.with_lock`;
`_raw_lock`/`_raw_unlock`/`_raw_handle_ptr` off the public surface;
`JoinHandle` `Dispose`; `spawn_blocking`. (`interval` and the concurrent
`Mutex` tests landed 2026-09-10 — below.)

**`interval` — LANDED 2026-09-10.** `std/time/sleep.yo` gains `Interval` and
`interval(period, io)`. The reason it exists rather than a `sleep` in a loop is
DRIFT: `while(true, { work(); sleep(period); })` takes `period + work` per
iteration, so 100 ticks of 10 ms work on a 1 s period ends 1 s behind. An
interval anchors each tick to a SCHEDULE — tick `n` is due at
`start + n * period` — so the work comes out of the wait instead of being added
to it. The first `tick()` is immediate, as Tokio's is.

Missed ticks **burst**: after an overrun the owed ticks are already due and
come back to back until the schedule is caught up (Tokio's
`MissedTickBehavior::Burst`). That is right for anything counting ticks, since
the total over a window is what the period promises, and WRONG for a rate
limiter, which wants a stall to swallow ticks rather than repay them. Tokio's
`Delay`/`Skip` are deliberately NOT implemented: the choice belongs to the call
site and guessing it here would be worse than leaving it out.

Tested on the SCHEDULE, not the wall clock (`tests/time/sleep.test.yo`, 7/7):
`_next` advances by exactly one period per tick however long the body took —
which IS the no-drift property — the first tick is due at construction, and
three ticks owed after an overrun advance the schedule by exactly three
periods. A first version compared measured elapsed time against a computed
"a drifting loop would take ~180 ms" and failed on a macOS CI runner that took
492 ms: that runner needs 163 ms for a 60 ms sleep, so every 30 ms tick costs
~90 ms and BOTH loops blow past any absolute figure. Timer granularity is not
something a test can assume away. NO wall-clock assertion survives. One did
briefly — "a not-yet-due tick waits at least 20ms of its 30ms period", on the
theory that a slow machine makes a wait longer and never shorter. That is wrong
for a COARSE one: Windows timers have ~15.6ms granularity and windows-11-arm
measured 19ms for a 30ms wait. Whether `sleep` sleeps long enough is `sleep`'s
contract, covered by its own cases; re-asserting it inside the interval tests
only imported that flakiness.

**`Once.call` now runs its slow path under `Mutex.with_lock`** (2026-09-10),
and the long-standing NOTE claiming the old manual `_raw_lock`/`_raw_unlock`
pair could **leave the mutex held forever on an unwind is WRONG** — corrected
in place. `f` is an `Impl(Fn() -> unit)` and a closure cannot capture an
`Exception` ("Closures cannot capture a value of control-bound type"), so `f`
has no way to throw past that frame; the leak was never reachable. The rewrite
still stands: the guarantee is now structural rather than resting on `f`'s
signature staying un-throwable, and it removes three `_raw_*` call sites that
the privatization row needs gone. It was blocked until now on the `R = unit`
callback codegen bug, fixed 2026-08-26 and shipped in the v0.2.29 seed.

**`Mutex` has concurrent tests now** (`tests/sync/mutex.test.yo`, 8/8). Every
previous test in that file was single-threaded, so none of them could tell a
working `Mutex` from a no-op. The new three run 8 threads x 2000 contended
read-modify-writes and assert the exact total (a lost update is an off-by-any),
check that `with_lock` hands back the closure's value while the mutation
persists, and hammer 8,000 lock/unlock/lock cycles to catch an unlock that
fires at the wrong moment — which shows up as a deadlock rather than a wrong
number, so that one asserts progress.

**`spawn_blocking` is deliberately still open**, and this is why: it has to
bridge an OS thread's completion back into the single-threaded event loop, and
there is no waker. The shapes available today are a `yield` spin or a
1 ms-backoff poll (which is what `std/async/channel` already does), and both
are stopgaps that the waker work in this same group would immediately replace.
It belongs with that work, not ahead of it.

**`Mutex.try_lock`, `Condvar.wait_timeout`, `RwLock.try_*` — COMPLETE
2026-09-10.** The compiler half landed first; **v0.2.30 shipped it as the seed,
and the std half landed the same day.** This was the last "blocked on the seed,
not on design" row in the document.

The std surface, shaped to this library rather than transliterated:

- **`Mutex.try_with_lock(body) -> Option(R)`**, not `try_lock() -> Guard`.
  `Mutex(T)` deliberately has no guard type — access is only granted inside a
  closure — so the "did I get it" answer is the `Option`. `body` not running IS
  the failure case, which is why the result is optional rather than the lock
  state being reported alongside a value: there is no way to observe "not
  acquired" and still have one. Release goes through the same
  `__MutexUnlocker`, so an early `return` or `unwind` out of `body` unlocks.
- **`Mutex.is_unlocked()`**, documented as advisory and racy by construction:
  it takes the lock to find out and releases it again, so the answer describes
  a moment that has passed. Branching on it to predict whether a later
  `with_lock` blocks is a TOCTOU bug, and the name is a question about the past
  for that reason.
- **`Cond.wait_timeout(handle, Duration) -> bool`** — true on a wake (possibly
  SPURIOUS, which the caller must re-check its predicate for either way),
  false only on a genuine timeout. The doc states the trap Rust also states:
  the timeout is per WAIT, not per loop, so a spurious wake restarts the full
  budget and a predicate loop can outlast its nominal deadline. Track an
  `Instant` and pass the remaining time when the total matters.
- **`RwLock.try_with_read` / `try_with_write` -> Option(R)`**, with the trap
  spelled out: a SINGLE concurrent reader is enough to make `try_with_write`
  fail, so it fails far more often than `try_with_read` under a read-heavy
  load, and polling it can starve a writer indefinitely — which is exactly
  what the blocking `with_write` avoids by parking in the queue.

**One claim in the old note was wrong and is corrected here: `RwLock.try_*` did
NOT need `__yo_mutex_trylock`.** Its job is to test `_writer`/`_readers` and
bail without a condvar WAIT; that test happens under the short internal mutex,
held only for a few field reads and never across a wait. Blocking on that is
bounded and unrelated to how long the RwLock itself is held, so the
non-blocking part was always skipping the wait, not skipping the mutex. Only
`Mutex.try_with_lock` and `Cond.wait_timeout` were genuinely seed-gated.

Coverage: `tests/sync/mutex.test.yo` 12/12 (+4), `tests/sync/rwlock.test.yo`
22/22 (+5), and a NEW `tests/sync/cond.test.yo` (6) — `Cond` had no test file
at all, so `wait`/`signal`/`broadcast` were untested too. The tests use a
`Channel` handshake rather than sleeps, so contention is deterministic; the
trylock contention cases are cross-thread on purpose, since a same-thread
re-entry is the one case where Windows (recursive `CRITICAL_SECTION`) and POSIX
legitimately disagree. Two of them assert the absence of a leak rather than a
value: that a failed `try_with_read` leaves the reader count untouched (a bail
after incrementing would make the lock permanently unwritable), and that four
`broadcast` waiters all run to completion (a `signal` would leave three parked
and HANG rather than report a wrong number).

The runtime side, for reference — `__yo_mutex_trylock` and
`__yo_cond_timedwait` live in `src/codegen/types/generation.yo`, and the
sequence that got them usable was: compiler PR (#529) → release v0.2.30 →
`SEED_VERSION` bump → the std PR.

Three platform shapes, and the reason for each:

- **Windows** rounds the timeout UP to the next millisecond.
  `SleepConditionVariableCS` takes milliseconds, so truncating a
  sub-millisecond timeout to 0 makes it return IMMEDIATELY — a "wait 100 us"
  would never wait at all. Only `ERROR_TIMEOUT` counts as a timeout; any other
  failure is reported as a wake so the caller re-checks its predicate rather
  than concluding the wait expired.
- **macOS** uses `pthread_cond_timedwait_relative_np`. It has no
  `pthread_condattr_setclock`, and the relative form needs no deadline
  arithmetic and no clock agreement at all.
- **Linux** binds the condvar to `CLOCK_MONOTONIC` at init and reads the
  deadline from the same clock. The clock is a property of the CONDVAR, not of
  the wait — `pthread_cond_timedwait` interprets its absolute deadline with
  whatever clock the condvar was created with — so the two MUST agree, and one
  macro names it for both. Everything else POSIX (wasm) falls back to the wall
  clock for both halves.

`__yo_cond_init` therefore changed from a macro to a `static inline` on POSIX,
which is shared with the GC's stop-the-world condvar and the parallelism
workers. **The blast radius is nil in practice:** an UNTIMED
`pthread_cond_wait` never consults a clock, so binding the condvar to
`CLOCK_MONOTONIC` changes nothing for any existing waiter — only a timed wait
can observe it, and until the std half lands the only timed wait in the tree is
the test below.

Coverage: `tests/sync/timedwait.test.yo` (6 tests) declares both primitives
`extern` and exercises them — `tests/` is not seed-gated, so this is what
proves they WORK a release before `std/` can call them, which a `static inline`
with no caller would otherwise never demonstrate. It covers an uncontended
trylock, a trylock contended from ANOTHER thread (a same-thread re-lock is not
portable: a Windows `CRITICAL_SECTION` is recursive and answers true where a
POSIX `NORMAL` mutex answers false), a timeout WITH an elapsed-time assertion,
an early return on signal, a sub-millisecond timeout, and zero/negative
timeouts. The elapsed assertion is the load-bearing one: a deadline whose
`tv_nsec` escapes `[0, 1e9)` makes `pthread_cond_timedwait` return `EINVAL`
immediately, which is indistinguishable from a timeout by return value alone.
Verified locally on macOS (60 ms measured for a 50 ms request) and under
`--c-compiler emcc`, which takes the same absolute-deadline path Linux does;
the `CLOCK_MONOTONIC` init itself is Linux-only and is covered by CI's Linux
legs.

**A live runtime bug sits under this group:**
`issues/yield-resumption-order-diverges-on-macos-ci.md` — two tasks that
`yield` in submission order have twice resumed in reverse order on macOS CI
legs, from PRs touching nothing async. The ready queue was read and IS strict
FIFO, so the issue's original "make it FIFO" fix is refuted; the open
candidates are the `io.spawn` codegen path, how an await of an
already-completed future suspends, and corruption via the LIFO continuation
free list. Do not weaken the assertion — it encodes the documented
cooperative-scheduling contract.

---

## 4b. Language features this campaign is blocked on

Five rows cannot be closed in `std/` alone. Each now has a design doc written
from the blocked call sites, in `plans/backlog/`:

| blocked row | language feature | doc |
| --- | --- | --- |
| waker-based `yield`/async `channel`/async `mutex`; `spawn_blocking` | a `Waker` + `park` primitive, so one task can be woken by another's progress | [`WAKER_BASED_SCHEDULING.md`](backlog/WAKER_BASED_SCHEDULING.md) |
| `_raw_lock`/`_raw_unlock`/`_raw_handle_ptr` off the public surface; `ctrl`/`data`/`size` private; `imm/*` internals | member visibility (`priv`, plus a path-prefix scope for the cross-module `std/` callers) | [`MEMBER_VISIBILITY.md`](backlog/MEMBER_VISIBILITY.md) |
| `TcpListener.incoming` | a `Stream` trait — the async analogue of `Iterator`. **Needs no compiler change** | [`ASYNC_ITERATION_STREAM.md`](backlog/ASYNC_ITERATION_STREAM.md) |
| the ten per-type byte conversions; `usize`/`isize` byte conversions at all; `Array(T, N)`'s `Default` | value substitution in a TYPE position — an associated constant as an `Array` length silently resolves to 0 (`issues/associated-constant-in-a-type-position-resolves-to-zero.md`) | [`VALUE_SUBSTITUTION_IN_TYPE_POSITIONS.md`](backlog/VALUE_SUBSTITUTION_IN_TYPE_POSITIONS.md) |
| `rand.thread_rng` | thread-local storage | [`THREAD_LOCAL_STORAGE.md`](backlog/THREAD_LOCAL_STORAGE.md) |

`ErrorChain`/`root_cause` is a sixth blocker but is a compiler DEFECT rather
than a missing feature —
`issues/self-trait-in-a-return-type-loses-the-trait-on-an-erased-receiver.md`
(filed as #521).

**Three "Yo has no X" claims in this document were measured and found false**
on 2026-09-10, so treat the rest with the same suspicion:

- `T.BITS` as an associated constant — `MIN`/`MAX` were already exactly that.
- Associated TYPES — a documented feature (`docs/en-US/DESIGN.md`'s
  `Iterator`/`IntoIterator`), working today in a return position, supplied
  per-type, consumed from a blanket impl and used as a constructor.
- `async/channel.try_recv` "still returns `Option(T)`" — it returns
  `Result(T, TryRecvError)` and has since #506.

Each cost a per-type workaround that was written and then deleted. Probe
first.

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

   Still open in this group: `TcpListener.incoming` and `Watcher` `Dispose`.
   (`Seek`, `OpenOptions`, `SystemTime`, `UdpSocket.recv_from -> (n, from)`,
   `IpAddr.parse_v6`, `StatusCode`, `HeaderMap` and the byte-sliced response
   body all landed 2026-09-09; lazy `read_dir` and the request-side byte bodies
   were already in.)

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
   comments/serializer, and the module-prefix stutter. (regex Rust-shaped
   names, `GlobPattern.new -> Result` + filesystem `glob()`, `Url.set_*` and
   `EncodingError` offsets all landed 2026-09-09.)

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
   - **`async/channel.try_recv` returned `Option(T)`** where `sync/channel`'s
     returns `Result(T, TryRecvError)` (#495). ALIGNED in the follow-up: the
     async channel now returns the SAME `TryRecvError`, imported from
     `std/sync/channel` rather than redeclared, so the two channels report one
     distinction with one vocabulary. A closed channel with buffered values
     still yields them — `Disconnected` means closed AND drained, which is the
     case the old `.None` could not express and which the new test pins.

   **Text — `write_padded` pads by RUNES, and `Writer` is retired (2026-09-09).**
   Two §4 Text rows, and they turned out to be the same row.

   `fmt.Writer.write_padded` measured width with `s.len()`, which for a `str`
   is BYTES, while `FormatSpec._apply_width` next door has always used
   `text.chars().count()`. So `{:8}` and `write_padded(s, 8, …)` disagreed on
   any non-ASCII text — `"héllo"` is 6 bytes and 5 runes, so it got two pad
   characters where a column needs three. It now counts runes, by scanning for
   UTF-8 lead bytes (`str` has no rune iterator: it exposes `len`, `ptr` and
   `bytes(i)`).

   The "one string builder" row resolved by MEASURING the two candidates
   instead of picking one. `StringBuilder` has 87 references across 14 files,
   most of them in the compiler itself; `Writer` had three importers in all of
   `std`, and of its 18 methods exactly FIVE had a caller anywhere — `new`,
   `to_string`, `write_str`, `write_string`, `write_hex`, plus `write_f64` from
   `fmt/format`. So `Writer` is retired into `StringBuilder` rather than the
   other way round, and only the methods with a caller (plus the audit's
   `write_padded`) came across. `write_bool`, `write_octal`, `write_binary`,
   `write_bytes`, `write_i64` and `write_u64` had none and were not carried:
   `sb.push_string(n.to_string())` covers them, and interpolation covers most
   of the rest.

   `StringBuilder.to_string` inherits `Writer`'s O(1) hand-over. It used to
   copy the buffer out byte-by-byte through `get(i)` and then reset, so
   building an N-byte string cost O(N) again to read it back.

   `Alignment` moves to `std/string/string_builder` (where `write_padded` is)
   and both it and `StringBuilder` are re-exported from `std/fmt` — that is the
   audit's "`Alignment` exported" row: it WAS exported, from its own module and
   from nowhere a `std/fmt` user would look. The dependency only goes one way;
   `std/fmt` already imports `std/string`.

   **Still one vocabulary too many, and the end state is decided:** `String`
   itself is already an amortized builder (`push_str`/`push_string`/
   `push_rune`/`push_byte` append in place over an `ArrayList(u8)`, with
   `with_capacity` and `reserve`), which is exactly Rust's answer — you build
   into a `String`. `StringBuilder` should collapse into it. That is 87 call
   sites, most of them in the compiler, so it is its own PR with its own gates,
   not a rider on this one.
5. **Freeze** — re-run the five measurements; a module freezes only when its
   group's list is empty.

Per-group raw findings — every file:line, the Rust counterpart for each item,
and the doc-coverage tables — are in `plans/STD_API_STABILIZATION_FINDINGS.md`.
This document keeps the decisions and the ranked list so it stays readable.
