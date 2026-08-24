# std API audit — the road to a stable, batteries-included standard library

**Status: IN PROGRESS (audit complete 2026-08-22; all §8 open questions DECIDED
by the user 2026-08-23; S0 correctness fixes underway).** Method: six parallel full-surface catalog sweeps (core/prelude,
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

## 2. Correctness bugs found by the audit (fix immediately, file in `issues/`)

Ranked by severity; none of these are API-design questions.

**Progress:** C1–C5 + C9 LANDED in PR #229 (2026-08-23, with red-first tests
under `tests/{http,net,time,crypto,fs}/`). C6, C8, C10, C12, C13 fixed
2026-08-23 (this tree; red-first where the failure is reachable — C10's
syscall failure is not, so it has no dedicated test). Notes against the
audit text: the C6 bool-arithmetic claim was STALE (no such impls exist —
only the f32/f64 bitwise four and the five unsigned `Negate`s were real);
C13's rwlock atomicity claim could not be found in the current source and
was left alone. **C12 uncovered TWO compiler bugs**: (1) a future's owned RC result
was NEVER dropped (empty sync-future dispose / warning-comment state-machine
dispose), so `Dispose` of any async-produced object never ran — fixed in
`src/codegen/exprs/async.yo` with inline-drop fallbacks
(issues/async-future-result-never-dropped.md; regression test in
tests/async_await.test.yo); (2) unmasked by (1): the async post-while
cond-branch cleanup re-executed on a stale `cond_branch_N` key,
over-releasing every RC slot it dropped — bug (1)'s leak had absorbed
exactly one extra drop per awaited result — fixed by consuming the key
after the guarded cleanup (`src/codegen/async/state_machine.yo`;
issues/async-postwhile-branch-cleanup-double-drop.md; gated by the
fs_walker tests). **C12 Windows follow-up (2026-08-24):** PR #238's two
Windows legs failed at the BufWriter Dispose test — the dispose flush used
CRT `_write`, but async-opened file fds wrap FILE_FLAG_OVERLAPPED handles
CRT `_write` cannot serve. Fixed with a per-platform positioned
`__yo_sync_write` runtime shim (POSIX: pwrite + ESPIPE fallback; Windows:
OVERLAPPED WriteFile with low-bit hEvent so completions never post to the
async loop's IOCP), surfaced as `std/sys/file.yo write_sync`; the CRT
`_write` binding is deleted from `std/libc/windows.yo`. **C11 FIXED
2026-08-24** (static-data rewrite + tests + scan-loop cleanup + the
`generic`→`forall` data bug — see the C11 row). Remaining: C7
(reclassified → O7, now DECIDED — lands with the S2 sweep) — §2 is
otherwise COMPLETE.

| # | Bug | Where |
|---|-----|-------|
| C1 | **`https://` is silently downgraded to cleartext HTTP** — client accepts the scheme, connects to :443, speaks plaintext. Until TLS exists, `fetch` must THROW `UnsupportedScheme` on https. | `std/http/client.yo:256-281` |
| C2 | `_make_sockaddr` hardcodes `::1` for EVERY IPv6 address (copy-pasted in tcp+udp); `accept` fabricates peer IP as `0.0.0.0`; `local_addr` echoes the bind arg so port-0 ephemeral binds report 0 (no `getsockname`) | `std/net/tcp.yo:44`, `std/net/udp.yo:42` |
| C3 | `lookup_host` imports `AF_INET6` but silently drops every AAAA record | `std/net/dns.yo` |
| C4 | `DateTime.to_string` always emits `Z`, ignoring the struct's own `utc_offset_secs` — non-UTC values stringify as UTC | `std/time/datetime.yo` |
| C5 | `crypto.random_range` is modulo-biased (no rejection sampling) — a bias defect in a module advertising crypto security; `random_f64` returns closed `[0,1]` not `[0,1)` | `std/crypto/random.yo` |
| C6 | `f32`/`f64` implement `BitAnd/BitOr/BitXor/BitNot` (C rejects float bitwise — likely doesn't even codegen); `bool` implements `Add/Sub/Mul/Div/Mod/Negate/shifts` (~290 lines); unsigned ints implement `Negate` | `std/prelude.yo` (impl blocks) |
| C7 | ~~GC `Trace` gaps in `imm/`~~ **RECLASSIFIED 2026-08-22 (wrong premise):** the imm family is ATOMIC RC, and `__yo_decr_rc_atomic` does no cycle bookkeeping by design (Arc pattern — atomic objects are never GC-tracked), so a `Trace` impl there would be dead code; the ArrayList analogy does not transfer (ArrayList is thread-local RC). The REAL issue: `Arc(V)` requires `V <: (Send, Acyclic)` while imm types require only `Send`, so a cycle routed through an imm structure leaks silently and unavoidably. → S2 decision (new **O7**): require `Acyclic` on imm element types like Arc does (breaking), or keep `Send`-only and document the leak. Module docs now warn either way. | `std/imm/*` |
| C8 | `Channel.send` DROPS the value on failure (`Result(unit, unit)`); Rust returns `SendError(T)` | `std/sync/channel.yo` |
| C9 | `walker.WalkOptions.follow_symlinks` is declared and never read | `std/fs/walker.yo` |
| C10 | `Instant.now()`/`DateTime.now_utc()` discard `clock_gettime`'s return code — a failing clock silently yields epoch | `std/time/instant.yo`, `datetime.yo` |
| C11 | **FIXED 2026-08-24.** `decode_html` carried three `// TODO: proper break` overflow hacks, and the module was UNTESTABLE — `html_entities.yo`'s runtime map build emitted one ~2,125-insert C function that CRASHED clang at -O0 (why zero tests existed). Landed: static-data blob rewrite (2,256→76 lines), the test suite (`tests/encoding/html.test.yo`), the scan-loop cleanup — plus a data bug found by re-encoding: `generic` was a mangled `forall`, so `&forall;` never decoded. issues/fixed/html-entities-runtime-map-uncompilable-in-tests.md | `std/encoding/html.yo` |
| C12 | `TempDir`/`TempFile` doc says "RAII-managed" but neither implements `Dispose`; `BufWriter` has no `Dispose` so buffered bytes are silently lost | `std/fs/temp.yo`, `std/sys/bufio/buf_writer.yo` |
| C13 | `sync/rwlock` doc claims atomicity it doesn't have; `mutex.yo` doc says `Drop` where the trait is `Dispose`; `Channel`/`WaitGroup` doc examples call `Thread.spawn(() => …)` against the real `(io : Io)` signature; `imm/map.yo` docstring demos an `Index` impl the type doesn't have; `ArgParser` doc shows three methods that don't exist; `toml.yo` doc imports a nonexistent `std/encoding` barrel | various |

---

## 3. Cross-cutting decisions (each becomes a short ADR section when implemented)

### D1 — Error handling: three blessed styles, no fourth

- **Effects (`exn : Exception` / `IoExn`)** for I/O and anything on the `io` path
  (fs, net, http, process). Already dominant; bufio's `Future(Result(_, IoError), Io)`
  and env's `Result(_, String)` migrate to it.
- **`Result(T, TypedError)`** for pure fallible transforms: parsing, decoding,
  conversion. Every error type is a real enum implementing `Error()` — kills
  `Result(_, String)` (`toml_parse`, `Regex.new`, `base64_decode_string`,
  `env.cwd`).
- **`Option(T)`** only for lookups where absence is not an error.

Supporting prelude work: `AnyError` downcast (`is(T)`/`as(T)`), a
`derive_rule(Error, …)` so error enums stop hand-writing `ToString` + `Error()`,
and `Error.source` actually used for chaining (`wrap`/`context` helper).

### D2 — Naming conventions (the rename sweep, §5, enforces these)

| Concept | Blessed name | Displaces |
|---|---|---|
| element count | `len()`; `is_empty()` on EVERY container | pub `size` fields, missing `is_empty` on ArrayList |
| map insert | `insert(k, v) -> Option(V)` (old value) | `set` (HashMap/BTreeMap/OrderedMap) |
| set insert | `insert(v) -> bool` | `add` (HashSet) |
| sequence append | `push` / `push_front` / `push_back` | — |
| membership | `contains` (seq/set), `contains_key` (map) | BTreeMap's missing both |
| value iterator | `into_iter()`; pointer iterator `iter()` | `iter_ptr`, OrderedMap's value-`iter` |
| accessors | bare noun, no `get_` prefix | `ParsedArgs.get_flag`, reflection `get_info` |
| byte codecs | `encode` / `decode` | `to_ascii`/`to_unicode` (punycode) |
| text formats | `parse` / `stringify` | `decode_html` (→ `html_decode` + new `html_encode`) |
| conversion | `from_` / `to_` / `into_` (Rust discipline) | `to_cstr` vs `to_c_str` pair |
| comptime twins | `Comptime` prefix on traits, `comptime_` on methods — and fix the one infix outlier (`to_comptime_string`) | — |

### D3 — Prelude trait additions (the deepest gap in the whole audit)

**Progress (S1 chunk 1, 2026-08-23, branch s1-prelude-traits):** D3.1
`Default` trait + impls (all int/float primitives, bool, `Option(T)`→`.None`,
`String`→empty, `ArrayList(T)`→empty) and `Option.unwrap_or_default`; D3.2
`From`/`Into` traits + the lossless integer/float widening seed impls
(`into(T)` disambiguates by its type argument like `try_into`; multiple
`From` impls on one type are selected with the explicit
`(T <: From(S)).from(v)` dispatch form — Yo has no overloading); D3.3
`Ord.cmp -> Ordering` with a `<`/`==`-derived default, float TOTAL-order
overrides (NaNs equal, greater than +inf) and float `Hash` DELETED per the
no-PartialOrd decision; `ComptimeOrd`/`ComptimeToString` exported; dead
`Exponentiation`/`ComptimeExponentiation` deleted. `derive(Default)` is
DEFERRED to the next chunk: emitting `(FieldType <: Default).default()` per
field needs a Type→source-expr rendering the derive surface
(`TypeFieldInfo.field_type : Type`) doesn't expose yet — needs either a
`Type.to_expr` builtin or per-field type names guaranteed reparseable.
**PR #240 opened 2026-08-24 (stacked on #238)** after the full local battery:
check 154+262, suite 2823/2823 under the S1 stage-1, gates green after
re-recording the 2 legitimately-drifted CLI goldens (`check-watch-once` expr
count, `lsp-completion` type ids + the new `default` entry), FIXPOINT_HOLDS.

**Progress (S1 chunk 2, 2026-08-24, branch s1-option-result, stacked on
chunk 1):** D3.7 Option/Result completion — Option gains `expect`,
`is_some_and`, `inspect`, `take`/`replace` (`inout(self)`, per the prelude's
Index/Hash precedent), `zip` (returns `Option(IterPair(T, B))`; defined after
`IterPair`), `transpose`; Result gains `unwrap_or`, `unwrap_or_default`,
`expect`/`expect_err`, `inspect`/`inspect_err`, `flatten`, `transpose`; both
gain `Ord` (`None` before every `Some`; every `Ok` before every `Err`; `cmp`
via the chunk-1 default) and `Hash` (variant tag mixed into the inner hash),
and `ToString` in `std/fmt/to_string.yo` (`Some(42)` / `Ok(1)` forms — so
`println(opt)` compiles). `expect` takes `msg : str` and forwards to
`__yo_panic` (prelude cannot import std/assert). NOT taken: `is_ok_and`/
`is_err_and` (not in the audit list), Rust's `get_or_insert` family (needs
`inout` chaining ergonomics first). Tests: 5 new cases in
tests/prelude.test.yo (18/18) — note closures capture locals BY VALUE, so
side-effect tests observe through an ArrayList.

**Progress (S1 chunk 3, 2026-08-24, branch s1-iterators, stacked on
chunk 2):** D3.4 iterator completion (minus `collect`/`rev`/`flat_map` —
see below) — consuming methods `find`, `position`, `last`, `nth`, `sum`
(`A <: (Add(A), Default)`; `Add(T, Output := T)` binding syntax is NOT
supported on parameterized trait constructors — plain bounds + per-call
resolution works), `min`/`max` (`A <: Ord(A)`, first-of-equals /
last-of-equals); new combinators `chain`, `take_while`, `skip_while`,
`filter_map`, `peekable` (with inherent `peek()`); `filter`'s callback
asymmetry FIXED — the predicate now takes the element BY VALUE like `map`
(breaking, in-window; 3 test files swept). **Two compiler findings en
route:** (1) variable-bound combinator receivers with a structurally-erased
type param (`m := xs.map(f); m.for_each(g)`) failed generic-impl matching —
pre-existing, latent; FIXED for map/filter_map/chain by walking the SomeT
resolution-chain cell in `_bind_forall_from_type_args`
(issues/varbound-combinator-receiver-impl-match.md). (2) `flat_map` is
DEFERRED entirely: its doubly-derived `B` (through `F → M → Item`) ships
under-resolved in the stamped type — var-bound fails at eval (empty `F`
cell), chained fails at CODEGEN (abstract-keyed specialization,
`B_id_B_wcforall` in the mangled name, incompatible C struct split) — needs
the stamping-side fix first (same issue doc, REMAINING section). Also
deferred, each needing new machinery: `collect`/`FromIterator`
(trait-generic-method prototyping), `rev`/`DoubleEndedIterator` (pairs with
D3.5 Range iteration). Tests: 10 new cases in
tests/iterator_combinators.test.yo (28/28).

**Progress (S1 chunk 5, 2026-08-24, branch s1-tostring, stacked on
chunk 3):** D3.8 ToString completion — the eight C-interop integers
(`int`/`uint`/`short`/`ushort`/`long`/`ulong`/`longlong`/`ulonglong`) plus
`longdouble` (`%Lg`), and containers: `ArrayList(T)`/`Array(T, N)` print as
`[a, b, c]` where `T <: ToString` (nests through Option/Result's chunk-2
impls), so `println(list)` compiles. `to_string.yo` now imports ArrayList
(no cycle — array_list does not import fmt). DEFERRED: `unit` — an
`inout(self)` receiver of type unit emits an invalid C ref-spill
(`void __yo_ref_spill_N = ;`,
issues/inout-unit-receiver-void-ref-spill.md). Tests: 2 new cases in
tests/fmt.test.yo (5/5).

**Progress (S1 chunk 4, 2026-08-24, branch fix/range-op-era-split —
UNPARKED, compiler fix + std landed together):** D3.5 implemented on the
std side (`RangeOp`/`RangeInclusiveOp` for all ten integer types;
`Iterator` for `Range(T)`/`RangeInclusive(T)`, the inclusive form flipping
to canonical-empty after yielding `end` so `start..=T.MAX` terminates).
The blocker — `..`-built values living in their own TYPE ERA so no trait
impl ever dispatched on an operator-built range — was a compiler bug one
level deeper than first recorded: `substitute()` KEEPS the
trait-definition era's struct id/ctor-fid when rewriting `Range(Self)`'s
type arguments, so the operator's stamped result was an instance the ctor
memo never issued. Fixed by canonicalizing the operator-dispatch result
stamp through the CTFE ctor memo
(`canonicalize_instantiation_via_ctfe_memo`, evaluator/calls/comptime_fn.yo
+ the operator arm of calls/function.yo) — record:
issues/fixed/range-op-result-era-split-blocks-iteration.md. En route,
found (pre-existing, OPEN, not range-specific): an Item-binding combinator
(`min`/`max`/`sum`) after `.map` at a SECOND Item type adopts the FIRST
call's Item — the combinator-chain shared-stamp pollution,
issues/iterator-chain-shared-stamp-cross-item-pollution.md (same
under-resolution family as the flat_map residual). Tests: 4 range cases in
tests/iterator_combinators.test.yo (32/32).

**Progress (S1 chunk 6, 2026-08-24, branch s1-intoiter, stacked on the
chunk-4 fix branch):** D3.6 — every collection's inherent `into_iter` is now
a real `IntoIterator` TRAIT impl (ArrayList, HashMap → `Bucket(K,V)`,
HashSet, Deque, LinkedList, PriorityQueue, BTreeMap → `BTreeEntry(K,V)`,
plus `Array(T, N)` in the prelude), so `where(C <: IntoIterator)` /
`IntoIterator(Item := X)` generic code finally dispatches; the `for` macro
and all 394 collections tests are unaffected. DEFERRED: a blanket
IntoIterator TRAIT impl for every Iterator (so ranges/combinator chains
satisfy the bound too) — needs assoc-of-assoc (`Item := I.Item`) in a
blanket impl; the inherent blanket `into_iter` still serves the `for`
macro. FOUND (pre-existing, OPEN — third face of the under-resolution
family): piling several instantiations of one where-bound generic leaves a
later instantiation's GC trace calls abstract-keyed → C compile failure;
minimal trigger LinkedList-then-BTreeMap,
issues/where-bound-intoiterator-gc-trace-abstract-key.md. Tests: 1 new case
in tests/iterator_combinators.test.yo (33/33), scoped away from the
landmine with a pointer at the issue.

1. **`Default`** trait + derive. Unblocks `unwrap_or_default`, map `or_default`.
2. **`From(T)` / `Into(T)`** (the prelude header already *claims* they exist).
3. **`Ordering` wired in**: `Ord` gains `cmp(self, rhs) -> Ordering` (default
   implemented via `<`/`==`), sort APIs take comparators via it. Today `Ordering`
   is a dead enum.
   **No `PartialEq`/`PartialOrd` split (decided with the user 2026-08-23,
   same taste as single-`ToString`/O5):** Rust's split exists to quarantine
   IEEE floats; Yo takes the smaller surface instead — (a) `cmp` is
   contractually a TOTAL order for every std impl; floats use a NaN-total
   order (all NaNs compare Equal to each other and Greater than every
   number incl. +inf; -0 == +0 — deliberately SIMPLER than IEEE
   `totalOrder`, and consistent with `==`) while the `<`/`==` OPERATORS
   keep plain IEEE behavior; (b) float `Hash` is DELETED (today's impl is
   `u64(i32(self))` — it truncates, so 0.5 and 0.9 already collide), which
   makes `HashMap(f64, …)` a compile error and kills the invariant-breaking
   case without a trait split; (c) if a real partial-order use case appears,
   `PartialOrd` can be ADDED additively later — the reverse is impossible.
4. **Iterator completion**: `collect` (via a `FromIterator` trait), `sum`, `min`,
   `max`, `find`, `position`, `last`, `nth`, `chain`, `flat_map`, `rev` (with
   `DoubleEndedIterator`), `take_while`, `skip_while`, `filter_map`, `peekable`.
   Fix `filter`'s callback asymmetry (`*(A)` vs `map`'s `A`).
5. **`Range(T) <: Iterator`** and `RangeOp` for all integer types — `for(0..10, …)`
   must work; today ranges don't iterate and only `usize` can even form one.
6. **`IntoIterator` actually implemented** by every collection (the `for` macro
   currently works by duck typing; generic `where(C <: IntoIterator)` code is
   impossible).
7. **`Option`/`Result` completion**: `expect`, `unwrap_or_default`,
   `Result.unwrap_or`, `flatten`, `transpose`, `inspect`, `is_some_and`, `take`,
   `replace`, `zip` — plus `Eq`/`Ord`/`Hash`/`ToString` impls so
   `println(opt)` compiles and options can key maps.
8. **`ToString` for every remaining primitive** (C-interop ints, `unit`) and
   containers (`Array`, `ArrayList`, `Option`, `Result`) — `println(list)` must
   work. Decide `Debug`-vs-`Display` split: recommendation — keep single
   `ToString` (Yo is not Rust; one string form), but route derive output through
   a `Formatter` so pretty/compact can be added additively later.
9. **`Hasher` design review**: `Hash` returning bare `u64` blocks DoS-resistant
   seeding and composite hashing. **DECIDED (user, 2026-08-24): full
   Rust-style `Hasher` trait** — `hash(self, hasher : inout(H))` writing into
   a streaming hasher (`write_u8`/…/`write_u64`, `finish`), with pluggable
   algorithms per map (SipHash-class seeded default; a fast unseeded option
   possible later). Breaking; lands in the S2 window with its own design
   round first (Hasher/BuildHasher shape, per-map seeding, derive(Hash)
   rework, every existing `Hash` impl + HashMap/HashSet/OrderedMap driver
   rewritten). The alternatives considered — keep bare `u64` forever, or a
   fold-style `hash(self, state : u64) -> u64` middle ground — were
   declined in favor of the most future-proof surface.
10. **Format specs**: template strings gain `${v:spec}` (width/precision/fill/
    align/hex) routed through `fmt.Writer`'s existing primitives — the engine
    exists, nothing connects it.

### D4 — String indexing model (the one genuinely hard call)

`String.len()` is rune-count O(n), `Index` returns a BYTE, `at()`/`substring()`/
`index_of()` are char-indexed, `starts_with(position)` is byte-indexed. Mixed
bases in one type is the worst of both worlds (regex pays a
`_byte_to_char_index` conversion per match).

**DECIDED (O1, 2026-08-23): go byte-indexed like Rust/Go.** `len()` = bytes O(1);
`chars()`/`char_indices()` for rune walks; `char_len()` for the O(n) count;
all find/slice APIs byte-indexed with a documented char-boundary contract.
This is THE breaking change to do before stability — it cannot be done after.

### D5 — Async I/O traits + the fd problem

`std/io.Reader`/`Writer` are sync, orphaned (zero implementors), and
incompatible with the async model. Redesign: async `Reader`/`Writer` traits
(`read(buf, io) -> Future(usize, IoExn)`), implemented by `File`, `TcpStream`,
`BufReader`, `BufWriter`, `Stdin`/`Stdout`; default methods `read_to_end`,
`read_to_string`, `write_all`, `lines()`; `io.copy(r, w)`. BufReader/BufWriter
move from `std/sys/bufio` to `std/io`, wrap any Reader/Writer (not raw fds),
and adopt `IoExn`. New `std/io/stdio.yo`: `stdin()/stdout()/stderr()` typed
handles (kills the `BufReader.new(i32(0))` magic number in the compiler's LSP).

### D6 — TLS position

No TLS in tree; C1 makes https throw for now. **DECIDED (O2, 2026-08-23):
`std/crypto/tls.yo` over platform libraries (SecureTransport/Schannel/OpenSSL)
via the existing `pkg_config` mechanism, behind one `TlsStream` type
implementing the D5 traits.** Until it lands, std honestly refuses https.

### D7 — sync/concurrency shape

- `Mutex(T).with_lock` closure style is the flagship — extend it: `RwLock(T)`
  becomes generic with `with_read`/`with_write` guards.
- Delete the parallel C-tier (`mutex_t`, `cond_t`); introduce opaque `RawMutex`
  for `Cond`'s signature; stop exporting `__MutexUnlocker`, `__YO_THREAD_SYNC_TYPE`.
- Atomics: `fetch_add/sub/and/or/xor/min/max` for ALL integer atomics (today
  only `AtomicI32` has add/sub), `fence`, receiver convention unified.
- `Once` gains `OnceCell(T)`-style `get_or_init`.
- Merge `std/worker` into `std/thread` as `ThreadPool` (explicit object:
  `spawn -> JoinHandle`-analog, `join_all`, `shutdown`); `Thread.spawn` should
  carry a result (`join() -> T`) and panic propagation.
- `WaitGroup`: delete (Go transplant) — replaced by `ThreadPool.join_all` +
  a new `Barrier`/`Semaphore` pair.
- **Async-aware sync is a P0 addition** (§7): async `Channel`, async `Mutex`,
  `select`/timeout — today any `ch.recv()` inside a future parks the entire
  single-threaded event loop, and the prelude DOCUMENTS `Channel` as the way to
  deliver results from `!Send` JoinHandles. Footgun with no safe path.

### D8 — module layout

- `std/os/env.yo` merges into `std/env.yo` (dir helpers return `Path`); `std/os/`
  then holds only `signal.yo` — flatten. `fs/temp` uses the merged `temp_dir()`
  (kills the 3rd copy of that logic; also consult `TMPDIR` on macOS).
- One shared `std/encoding/utf8.yo` (validate/decode_rune_at/encode_rune) —
  SIX private UTF-8 decoders exist today; `String.from_bytes` starts validating
  (or gains `from_bytes_unchecked`).
- `EncodingError` moves out of `hex.yo` into `std/encoding/error.yo`.
- Regex internals (`parser/node/compiler/vm` exports) go private; `MAX_SLOTS`
  documented; typed `RegexError`.
- `std/glob` stays the matcher; `fs.walker` gains `pattern` option + a
  `glob(pattern, io)` expansion function (the Python/Node meaning).

---

## 4. Per-module verdicts

| Module | Verdict | Notes |
|---|---|---|
| prelude | FIX + EXTEND | D3 traits; C6 impl removals; export `ComptimeOrd`/`ComptimeToString` (defined, never exported); delete dead `Exponentiation`, commented-out blocks; `if` macro deletion is seed-gated (owner: next seed bump after v0.2.16) |
| error/assert | EXTEND | downcast, derive(Error), context; narrow `error.yo`'s blanket `open(import(./string|./fmt))` re-export |
| fmt | FIX + EXTEND | delete `display.yo` (zero users) or wire it; format specs (D3.10); collapse 4 print bodies; dedupe 15 snprintf helpers |
| spec/ | FREEZE AS DOC | identity stubs; mark experimental, exclude from stability promise |
| collections/* | RENAME + EXTEND | §5 renames; entry API, `retain/extend/drain`, `binary_search`, real `sort` (not O(n²) insertion), `sort_by`; HashSet = HashMap(T, unit) to kill ~500 duplicated SwissTable lines; hide pub `ctrl/data/…` fields; `BTreeMap` → rename `FlatMap` OR implement a real B-tree with `range()` (recommend: real B-tree, keep name); add `BTreeSet`; `PriorityQueue`: keep name, add comparator ctor, DOCUMENT min-heap |
| imm/* | KEEP (O4) + FIX | stays in std (decided 2026-08-23); require `Acyclic` element bounds per O7, add iteration + `Index` where doc'd, rename `imm.String` → `ImmString` (or drop if COW `String` lands), dedupe set pair; mark unstable until exercised |
| string | FIX + EXTEND | D4 indexing; Unicode-correct `to_lowercase` (+ `to_ascii_*` variants); `Pattern` impl for `rune` + `Regex`; `replace*` Pattern-generic; `parse_f64`/radix; `split_once`, `strip_prefix/suffix`, `char_indices`; move `panic_dyn`/`assert_dyn` to assert; delete dead `StringError`, one of `to_cstr`/`to_c_str` |
| encoding | STANDARDIZE | D2 verbs; one error style per D1; utf8 module; add `html_encode` (XSS!); percent-encoding module (P0 — nothing in std can build a safe query string); base32; CSV (P1); toml: floats/arrays/dates/serializer + `ToToml`/`FromToml` derives to mirror json (P1) |
| json | EXTEND | enum representation for derives (open question O3); `JsonValue.Object` O(n) parallel arrays → keep repr, add index map if profiling demands |
| regex | POLISH | `Regex.escape`, optional-flags `new`, callback replace, lazy `find_iter`, group byte-spans, typed error, private internals |
| url | EXTEND | percent-encode/decode integration, `query_pairs`/`SearchParams`, `join` (RFC 3986 §5 — needed by http redirects), builder/setters, wire punycode into host handling (or delete punycode) |
| io | REDESIGN | D5 |
| fs | EXTEND + POLISH | wrappers: `copy`, `remove_dir_all` (compiler implements it TWICE as workaround — `src/fetch.yo:80`, `src/version_cache.yo:72`), `read_link`, `set_permissions`, `set_len`, `try_exists`, `watch` (sys/events exists); `OpenOptions` builder; `File.from_fd`; Metadata: real `btime`, `permissions()`, stop `metadata` re-stat by path; DirEntry `path()`; walker: lazy option + glob filter; complete the `_str`/`_cstr` variant matrix or (better) collapse it with a `Pattern`-style `AsPath` trait |
| path | FIX + EXTEND | `join(str)`, `push`, `strip_prefix` (rename of `relative_from`, fallible), `Hash`/`Ord`/`Clone`, Windows separator in `to_string`, `ancestors`, PATH split/join; revisit eager `..` normalization (symlink semantics); delete dead `PathError` or make `new` fallible |
| env | MERGE (D8) | + `remove`, `vars()` iteration, `str` keys |
| process | EXTEND | `Child`/`spawn`/`Stdio` piping, `env`/`current_dir` on Command, builder returns `Self`, `ExitStatus.code() -> Option(i32)`, hide `raw` |
| cli | EXTEND or DROP-TO-PACKAGE | typed values, required enforcement, `--` , repeated opts, help-not-an-error; needs tty/color access (D8 wrappers). Recommendation: keep minimal-but-correct in std |
| net | FIX + EXTEND | C2/C3; `Shutdown` enum; `Reader`/`Writer` impls (D5); `incoming()`; UDP `connect` (its own doc references it), typed `recv_from`; `UnixStream`/`UnixListener` (sys/unix.yo fully plumbed — lowest-effort high-value gap); `parse_v6`, `SocketAddr.parse`, `Eq`/`Hash` on addr types; RFC 5952 V6 formatting |
| http | FIX + EXTEND | C1; timeouts (dead `Timeout` variant becomes real), redirects (needs `Url.join`), chunked decoding, binary bodies (`Output`-style bytes + `text()`/`json()` accessors), keep-alive; **server (P1)**: `parse_request`, `HttpServer` on `TcpListener`, router-free minimal core; collapse `FetchOptions` into `HttpRequest` |
| async | PROMOTE | becomes the combinator home: `join_all`, `race`, `any`, `timeout`, async `sleep(Duration)`, interval, cancellation story for `JoinHandle` (`abort()`), async channel/mutex (D7) |
| thread/worker/sync | REDESIGN (D7) | |
| time | EXTEND | `Duration`: `Add/Sub` operator impls, `Eq/Ord/Hash`, `from_secs_f64`, `subsec_*`, consts; **make std USE it** (timeouts, sleeps — today zero consumers outside time/); `Instant` `add/sub`, `Eq/Ord`; `DateTime`: RFC3339 `parse`/`format` (C4 fix first), component ctor, arithmetic, `Eq/Ord`; ONE `sleep(Duration, io)` async + `sleep_blocking(Duration)` |
| crypto | EXTEND | streaming `Digest` trait unifying Sha256/Md5 (+ streaming Md5); SHA-1, SHA-512, **HMAC** (blocks JWT/SigV4/webhooks), CRC32, constant-time compare; fix C5; new `std/rand` module: seedable PCG/xoshiro PRNG, `shuffle`, `choice`, ranges — infallible, non-crypto, clearly separated from `crypto/random` |
| log | REWRITE (zero users = free window) | levels + `Off`, `ToString`-generic message, lazy eval, timestamps, target/module, writer sink (file/buffer), thread-safe; keep the free-function facade |
| testing | EXTEND | `assert_eq`/`assert_ne`/`assert_approx` (diff-printing), `bench`: auto-calibration, black_box, stddev/percentiles |
| gc/allocator | POLISH | `gc.stats()`; allocator: DECIDED (O6, 2026-08-23) — DELETE `CustomAllocator` (zero implementors incl. `GlobalAllocator`); per-heap control, if ever needed, arrives as a process-global runtime hook, not a type parameter |
| build | KEEP (already coherent) | Zig-shaped, comptime-correct; only additive evolution |

---

## 5. The rename/breaking sweep (one release — a PATCH bump, staying on v0.2.xx)

**Versioning decision (user, 2026-08-24): no minor release for this.** Yo is
pre-stability; breaking std changes ship in ordinary v0.2.x patch releases
rather than opening a "0.3.0" window. The sweep below is still ONE release's
worth of coordinated renames — it just lands as the next patch version.

Everything in D2/D4 plus these specific renames. Each is mechanical; land as a
small number of PRs with tree-wide fixups (compiler + std + tests + docs):

- `HashMap.set`→`insert`, `HashSet.add`→`insert`, `BTreeMap.set`→`insert`,
  `OrderedMap.set`→`insert` (returns stop leaking `HashMapError`)
- `ArrayList`: add `is_empty`; `remove(start,count)`→`drain(range)`, add
  single-`remove(idx) -> T`; `iter()` pointer iterator for symmetry
- `HashMap.iter_ptr`→`iter`; OrderedMap iterators get real `Iterator` impls
- `?(T)` spelling in btree_map/deque → `Option(T)` (or bless `?(T)` everywhere — pick one)
- `Bucket`/`BTreeEntry`/`OrderedMapEntry`/`Pair` → one `MapEntry(K,V)`
- `canonical`→`canonicalize`; `relative_from`→`strip_prefix`;
  `created_time`→`status_changed_time` + real `created_time` (btime)
- `File.read_string`/free `read_string`→`read_to_string`; `read_file`→`read`
  (bytes) mirroring `write_file`→`write`
- `min()`/`max()` naming: maps `first_entry`/`last_entry`, sets keep `min`/`max`
- `Http` inherent `to_string`→`ToString` impl; `TcpStream.shutdown(i32)`→
  `shutdown(Shutdown)`; net `read/write` return `usize`
- `punycode.to_ascii`/`to_unicode`→`domain_to_ascii`/`domain_to_unicode`
- two `sleep`s → `time.sleep(Duration, io)` async + `time.sleep_blocking(Duration)`
- `str.join(items)` receiver-as-separator: keep (Python style is fine) but
  document; `index_of`/`last_index_of` keep (JS names are the local norm) —
  the D2 table is the arbiter wherever vocabularies mix

## 6. Deletions (all pre-stability; each verified zero/near-zero usage by grep)

| Target | Evidence |
|---|---|
| `std/alg/hash.yo` | zero importers; docstring false; FNV constants re-inlined in both String hashes — inline or wire in |
| `std/encoding/punycode.yo` | zero importers incl. url; 343 untested spec-sensitive lines; ALSO duplicated at `vendor/markdown_yo` — delete OR wire into `Url` (D8) |
| `std/collections/list_view.yo` | test-only, no Index/iter/consumers; superseded by `slice_copy` |
| `std/collections/linked_list.yo` | test-only, 510 lines; `Deque` covers it (decide: delete vs keep-as-is; recommend delete) |
| `mutex_t`, `cond_t` | zero in-tree users, duplicate `Mutex`/`Cond` unsafely |
| `WaitGroup` | Go transplant; replaced per D7 |
| `std/io/{reader,writer}.yo` current traits | zero implementors — replaced by D5 redesign |
| `std/fmt/display.yo` | zero call sites, not re-exported, malformed trait shape |
| `StringError`, `PathError`, dead variants (`HashMapError.KeyNotFound`, `HttpError.Timeout`* etc.) | never constructed (*Timeout/TooManyRedirects/ResponseTooLarge become REAL when the features land — don't delete, implement) |
| `base64_{encode,decode}_string` | duplicate logic, second error style; fold into primary pair |
| `ExprInfo.popped_env_frame`-class dead fields, prelude commented-out blocks, `export();` no-op | listed in core report |
| underscore-private names in `export(...)` (fs/types converters, `__MutexUnlocker`, regex internals, `ArgDef`, `raw_args`/`argc`/`argv` duplicates) | export hygiene sweep |

## 7. Additions ranked (post-sweep, additive, batteries-included)

**P0 — unblock real programs**
1. `std/encoding/percent.yo` (percent-encode/decode) + URL/query integration
2. `std/encoding/utf8.yo` (D8) + `html_encode`
3. `std/io` redesign with stdio handles (D5)
4. `fs.copy`, `fs.remove_dir_all`, `read_link`, `set_permissions`, `try_exists`
5. `process.Child`/`spawn`/`Stdio`
6. async combinators + async channel/mutex + `timeout` (D7)
7. `crypto`: HMAC, SHA-1, SHA-512, CRC32, `Digest` trait; `std/rand`
8. prelude D3 items 1–8 (Default, From/Into, cmp, iterator/Option/Result completion, Range iteration)
9. `Duration` integration everywhere a timeout/interval appears
10. `net.UnixStream`/`UnixListener`

**P0+ — user-requested (2026-08-23), tracked with this campaign**
- `yo <subcommand> --help` per-subcommand help (today `yo version --help`
  errors with `unknown option`, and nothing tells the user `version list`
  has `--remote`) — CLI fix in `src/main.yo`, not std, but discovered by and
  shipped with this campaign.
- Replace the two `curl` shell-outs (`src/version_cache.yo:454,512` — bundle
  download + releases list, both https against the GitHub API) with
  `std/http`. **Blocked on TLS (D6/O2)**: std's fetch deliberately refuses
  https since C1, so the sequence is TLS `TlsStream` first, then the swap —
  doing it earlier would silently downgrade the toolchain's release channel
  to cleartext.

**P1 — expected of a modern std**
HTTP server + chunked/redirect/timeout client; TLS (D6); CSV; DateTime
parse/format; `fs.watch`; testing `assert_eq` family; log rewrite; glob
expansion; `Semaphore`/`Barrier`; `ThreadPool`; format specs; entry API +
`binary_search` + real sort; tty/terminal-size wrappers (cli needs them)

**P2 — nice-to-have / decide-later**
WebSocket; YAML/XML (lean package-ecosystem); msgpack/CBOR; base58;
`BTreeSet`+range queries (with the real B-tree); bitset; `SmallVec`; LRU cache;
mmap/file-lock/statfs wrappers; `gc.stats`; DNS SRV/TXT/reverse

## 8. Open questions — ALL DECIDED (user, 2026-08-23)

- **O1 (D4)**: **DECIDED — byte-indexed, matching Rust.** `len()` = bytes O(1),
  `chars()`/`char_indices()` for rune walks, `char_len()` for the O(n) count,
  find/slice APIs byte-indexed with a char-boundary contract.
- **O2 (D6)**: **DECIDED — platform TLS libraries via `pkg_config`**
  (SecureTransport/Schannel/OpenSSL), behind one `TlsStream` implementing the
  D5 traits. Until it lands, https throws `UnsupportedScheme` (C1).
- **O3**: **DECIDED — externally tagged** `{"Variant": {...}}` (serde default).
- **O4**: **DECIDED — keep `imm/` in std for now.** Fix bugs, mark unstable
  until it has real consumers; revisit promotion at stability time.
- **O5**: **DECIDED — single `ToString`.** No `Debug`/`Display` split; derive
  output routed through a `Formatter` so pretty/compact can be added additively.
- **O6**: **DECIDED — delete `CustomAllocator`** (zero implementors, never
  plumbs into collections). Rationale recorded: Yo objects are reference-
  counted, so a per-collection allocator parameter would have to flow through
  every RC header alloc/free — the Zig model doesn't fit. If per-heap control
  is ever needed, the additive path is a process-global allocator hook at the
  runtime-C level (Rust `#[global_allocator]` model — the mechanism the
  existing `--allocator system|mimalloc` flag already proves out), not a
  type-level parameter.
- **O7**: **DECIDED — require `Acyclic` on imm element types, like `Arc`.**
  The invariant is: atomic RC is only sound for acyclic data (no GC tracking),
  so `atomic(...)` of a non-`Acyclic` type is a BUG, not a feature request.
  Breaking bound added to the imm family in S2; additionally audit that no
  other std surface hands out atomic RC over non-`Acyclic` payloads.

## 9. Phasing

1. **S0 — correctness (immediately post-release):** §2 C1–C13, each with a
   red-first test. No API changes beyond C1's throw.
2. **S1 — conventions ADR + prelude traits (D1–D3):** the foundation everything
   else builds on.
3. **S2 — the breaking sweep (§5 + §6 + D4/D5/D7/D8):** one release window —
   a v0.2.x PATCH bump, per the §5 versioning decision (no minor release);
   compiler tree migrates in the same PRs (it is the biggest std
   consumer and the best test).
4. **S3 — P0 additions.**
5. **S4 — P1 additions.**
6. **S5 — stability freeze:** stable/unstable markers in `yo doc` output,
   additive-only policy documented in `yo-design.instructions.md`.

Every stage gates on: `yo check ./std && yo check ./src`, the full language
suite, the internal suite for touched areas, `gates_fast.sh` + fixpoint, and
docs in both `docs/en-US` and `docs/zh-CN` for user-visible surface.
