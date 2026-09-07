# v0.2.28

> **DRAFT** — pre-release notes for the std API stabilization D-batch.
> Archive this to `plans/archive/` once the release ships, per `plans/README.md`.

The **std API stabilization campaign's decision batch (D9–D18)** lands: twelve PRs
reshaping the exported signatures to Rust's, plus one silent-miscompile fix in
`derive`. This is the batch that changes what your code compiles to, so read the
breaking list — the campaign record is `plans/STD_API_STABILIZATION.md` §2.

## ⚠️ Breaking changes (patch-release policy)

The rule applied throughout: **allocation failure panics, a caller mistake keeps its
`Result`.** An out-of-memory `push` is not something callers meaningfully handle, so
it panics like Rust's; a bad key or a malformed string still returns `Result`.

- **`ArrayList.push` is infallible** (#468, D9a). `push : (fn(self, value : T) -> unit)`
  and panics on allocation failure. The allocator-aware form is
  `try_push -> Result(unit, ArrayListError)`. Measured before changing it: only
  281 of 4287 `push` sites consumed the old `Result`, and 493 of them were
  throwaway `_p :=` / `___ :=` bindings.
  `LinkedList.insert` is **unchanged** — its error is a bounds mistake, not an
  allocation.
- **`HashMap`/`HashSet`/`OrderedMap` `insert` is infallible** (#469, D9b).
  `insert -> Option(V)` (the displaced value, as Rust). The fallible form is
  `try_insert -> Result(Option(V), HashMapError)`.
- **`String.replace` now replaces EVERY occurrence** (#464, D10) — Rust's semantics.
  It previously replaced only the first. `replacen(search, new, n)` bounds the count,
  and `replace_first` / `replace_all` are explicit aliases if you want to say which
  you meant. **If you relied on the old single-replacement behaviour, you want
  `replace_first`.**
- **`PriorityQueue` is a MAX-heap** (#465, D11). `peek` and `pop` yield the
  **largest** element; they used to yield the smallest. For a min-heap, wrap the
  element type in the new prelude `Reverse(T)`.
- **`sort` is now STABLE** (#463, D17), matching Rust's `sort`. The previous
  heapsort is `sort_unstable`; `sort_by` / `sort_unstable_by` follow the same split.
  Stable costs a temporary buffer — reach for `sort_unstable` when you don't need
  the ordering guarantee.
- **`iter()` yields POINTERS** on `ArrayList` and `OrderedMap` (#461, D14).
  `iter -> ArrayListIterPtr(T)`, whose `Item` is `*(T)`, so a loop can mutate in
  place. `into_iter()` still yields values. Note **dereferencing a pointer needs
  `pragma(Pragma.AllowUnsafe)` in the file that does it** — but `for(list, x => …)`
  and `list(i) = v` both keep working with no pragma, so most code is unaffected.
  The scoping question this raises is written up in
  `plans/backlog/UNSAFE_SCOPING_AND_POINTER_ITERATORS.md`.
- **The decoders return `Result`** (#467 D13a, #472 D13b) instead of throwing:
  - `hex_decode`, `base64_decode`, `base64_decode_url`, `utf16_to_utf8` →
    `Result(…, EncodingError)`
  - `Url.parse` → `Result(Url, UrlError)`
  - `json_parse`, `json_parse_bytes`, `json_parse_string` → `Result(JsonValue, JsonError)`

  Each keeps a throwing `*_exn` wrapper (`hex_decode_exn`, `Url.parse_exn`,
  `json_parse_exn`, `utf16_to_utf8_exn`, …) — the mechanical migration is to append `_exn`.
  `json_parse_result` survives as a deprecated alias of `json_parse`.
- **`std/async`'s `timeout` returns `Result`** (#462, D18a):
  `timeout(handle, limit, io) -> Result(T, TimeoutError)` with
  `TimeoutError :: enum(Elapsed, Aborted)`, so an elapsed deadline and an aborted
  task are finally distinguishable.
- **`s.parse(T)` replaces the ad-hoc parse helpers** (#466, D12). A `FromStr` trait
  plus real error types — `ParseIntError`, `ParseFloatError`, `ParseBoolError` —
  and `parse(self, comptime(T), where(T <: FromStr)) -> Result(T, T.Err)`.

## New

- **`Debug` is split from `ToString`** (#470, D15). `derive(ToString)` used to emit
  the *structural* render — which is Rust's `Debug`, not Rust's `Display` — so no
  error type could derive a structural dump *and* carry a user-facing message.
  They are now separate channels: `derive(MyError, Debug)` for
  `MyError.NotFound(/tmp/x)`, a hand-written `ToString` for
  `no such file: /tmp/x`. `derive(ToString)` is **deprecated, kept for one
  release**. There is deliberately no blanket `impl(T <: ToString) Debug for T` —
  that would reintroduce the conflation.
- **`Reverse(T)`** in the prelude, next to `Ord` — a comparison-flipping wrapper,
  as Rust's `cmp::Reverse`.

## Fixed

- **A derived `ToString`/`Debug` body no longer references any name from the
  deriving file** (#474). A derive body is spliced through `.to_expr()`, which
  re-parses it, so its free names resolved in the *deriving* file's scope. The body
  emitted `String.from("…")`, so any file deriving without `String` in scope failed
  definition-time evaluation, had the failure **swallowed**, and compiled to an
  `abort()` stub — while `yo check` reported "evaluator OK" and the program died at
  rc=134 with no message. Pre-dated D15; `derive(ToString)` was affected identically.
  Literals are now emitted as `"…".to_string()`, which introduces no identifier.
  (`issues/fixed/derive-tostring-debug-body-is-unhygienic-and-aborts.md`)

## Internal

- **`HashSet(T)` is now a view over `HashMap(T, unit)`** (#471, D16) — 976 → 488
  lines, with one hash/probe/tombstone implementation instead of two. No API change;
  it relies on `unit` being a true ZST since v0.2.26.

## Known issues

- `Url` does not percent-encode components yet.
- `std/fs/watch` stays `unstable` pending its Windows backend.
- `derive` still **swallows** a definition-time body failure and emits an `abort()`
  stub that `yo check` calls clean — the general defect behind #474, not yet fixed.
- `.to_expr()` cannot parse a backtick template literal, and surfaces the failure as
  a misleading "derive rule must return(comptime(Expr))"
  (`issues/comptime-str-to-expr-cannot-parse-a-template-literal.md`).
- D18b (`Thread(T)` returning a value) is **blocked** on a compiler fix — either the
  spawn-lowering ZST bug or teaching `_capture_judgement_type` about
  `Impl(Fn, Send)`. Excluded from this release.
