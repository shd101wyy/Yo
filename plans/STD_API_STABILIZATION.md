# std API stabilization — the 2026-09-06 audit against the code and against Rust

**Status: ACTIVE.** Successor to the remaining rows of `plans/STD_API_AUDIT.md`
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
  release.
- **D10 — `replace` replaces ALL; `replacen(pat, to, n)` is the bounded form.**
  `String.replace` and `ImmString.replace` replace the first occurrence — every
  Rust/Python/Go user gets a silently different string. → swap semantics; keep
  `replace_first` for one release as a deprecated alias.
- **D11 — `PriorityQueue` is a MAX-heap, with `Reverse(T)` for min.** Today it
  is a min-heap under a name every Rust user reads as `BinaryHeap`. → flip +
  ship `Reverse(T)`; breaking.
- **D12 — numeric parsing is `Result(T, ParseIntError | ParseFloatError)` via a
  `FromStr` trait and `s.parse(T)`.** Eight `parse_*` methods return `Option`,
  collapsing empty / garbage / overflow into `.None` (the C34/C65 failure mode).
  The `Option` spellings stay one release as deprecated aliases.
- **D13 — pure decoders return `Result`; the effect form is a wrapper, never
  the primary.** `Url.parse`, `json_parse`(×3), `base64_decode`, `hex_decode`,
  `utf16_to_utf8` all throw through `Exception` for pure transforms; `json.yo`
  ships both styles in one file. → `Result` is the exported name; `*_exn`
  wrappers only where a caller demonstrably wants them.
- **D14 — `iter()` yields POINTERS everywhere** (D2 already says so).
  `ArrayList.iter` and `OrderedMap.iter` yield values → they become
  `into_iter`; `iter` gets the pointer iterator.
- **D15 — `Debug` is split from `ToString`.** `derive(ToString)` emits a
  structural render (Rust's `Debug`), so no error enum can derive its
  user-facing message and all ten std error enums hand-write `to_string` +
  `Error()`. → `Debug` trait + `derive(Debug)` (the current structural rule),
  `ToString` stays hand-written or comes from `derive(Error)` with per-variant
  format strings (thiserror's `#[error("...")]`).
- **D16 — `HashSet(T)` IS `HashMap(T, unit)`.** 498 of 929 lines of
  `hash_set.yo` are byte-identical to `hash_map.yo`, and the tombstone bug
  (§3) is present in both. `unit` is a true ZST as of v0.2.26, so the map's
  value slot costs nothing. Same treatment for `imm/set` over `imm/map`.
- **D17 — `sort` is stable; `sort_unstable` is the heapsort.** Today `sort` is
  heapsort under Rust's stable name.
- **D18 — `timeout` returns `Result(T, Elapsed)`; `Thread(T).spawn` carries
  its result and `join() -> T`.** `timeout -> Option(T)` conflates timed-out /
  aborted / `Some(None)`; D7's blocker on the join result is fixed.

Not decided here, needs the maintainer: whether `Box` (which is
reference-counted — Rust's `Rc`) keeps its name (§5).

---

## 3. P0 — fix before anything is frozen (each with its file:line)

Memory safety / UB / deadlock:

1. **`std/imm/vec.yo` leaks and drops uninitialized memory.** _(fix in PR #445)_ `push` grow
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
   crosses an OS thread. Compiler fix + `comptime_expect_error` negatives.
3. **`spawn(pool, …)` self-deadlocks on nested spawn** whenever the runtime
   takes its inline fallback: the pool mutex is held across
   `__yo_worker_spawn` (`thread.yo:218-221`) and the fallback runs the task on
   the submitting thread (`codegen/parallelism/runtime.yo:463-468`).
4. **`Thread.join` is re-callable (double `pthread_join`, UB) and `Thread` has
   no `Dispose`** (`thread.yo:61-64`; threads are created joinable and never
   detached, `runtime.yo:141-167`) — every un-joined thread leaks.
5. **`html` entity tables lazy-init through unsynchronised globals**
   (`encoding/html.yo:21-31`); **`std/log` globals raced** (`log.yo:81-101`,
   `168`) against a module doc that promises one mutex.

Wrong values:

6. _(fix in PR #446)_ **`IpAddr.parse_v4`** accepts `"..."` as `0.0.0.0` and wraps octets past
   `u32` (`net/addr.yo:37-88`).
7. _(fix in PR #446)_ **`UdpSocket.bind` echoes the bind argument** so an ephemeral-port bind
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
    `imm/vec._raw_alloc` (`vec.yo:79`) — _(both guarded in PR #445)_.
14. **`html_decode` is O(n²)** — rebuilds the result via a template string per
    character (`html.yo:162` + 12 sites) — **FIXED 2026-09-06**: appends in
    place into a pre-sized `String`. **`ArrayList.retain` is O(n²)** with an
    allocation per rejection (`array_list.yo:1160-1173`) — **FIXED 2026-09-06**:
    one pass over push / clear / extend, `rc()`-witnessed
    (`issues/fixed/array-list-retain-is-quadratic.md`).

Convention violations that change signatures (do them in the same breaking
window as D9–D18):

15. **`Result(_, String)` in five exported APIs** — `env.cwd/current_exe/chdir`
    (`env.yo:166,266,414` — io-path, should throw `IoExn`) and
    `http.parse_request/parse_response` (`http.yo:231,313` → `HttpParseError`).
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
    no `## Stability` marker, so this shape is already frozen.

---

## 4. P1 — expected of a modern, Rust-shaped std (by module group)

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

**Text.** `next_back` on all four string iterators (D4 promised
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

- `Box` is reference-counted (Rust's `Rc`). Keep the name (document loudly) or
  rename? Every Rust reader will assume move semantics.
- `imm/Vec`: implement structural sharing (RRB), or re-document as a flat COW
  array and accept O(n) on shared mutation?
- `MemoryOrder.Consume`: keep (C11 has it; every compiler promotes it to
  `Acquire`; Rust omits it) or remove?
- `HashMap.new()` stays deterministic-keyed (the fixpoint gate depends on
  byte-identical emitted C); ship `with_random_keys()` for programs that face
  untrusted keys?

---

## 6. Phasing

1. **P0 memory/UB/deadlock (§3 1–5)** — one PR per module (`imm/vec`,
   `thread`, `html`+`log`), each with red-first tests over RC element types
   under `MallocScribble`; the `Send` enforcement is a compiler PR with
   `comptime_expect_error` canaries and an over-rejection canary per exempt
   shape.
2. **P0 wrong values + cliffs (§3 6–14)** — small PRs, each a bug with its test.
3. **The breaking window (§2 + §3 15–18)** — one release (v0.2.27 target),
   every change in the release notes' breaking section, deprecated aliases
   where an old spelling can survive one release.
4. **P1 additive work (§4)** — module by module, `## Stability` marker on every
   module touched, `///` sweep of the same module in the same PR.
5. **Freeze** — re-run the five measurements; a module freezes only when its
   group's list is empty.

Per-group raw findings — every file:line, the Rust counterpart for each item,
and the doc-coverage tables — are in `plans/STD_API_STABILIZATION_FINDINGS.md`.
This document keeps the decisions and the ranked list so it stays readable.
