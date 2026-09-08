# v0.2.28

> **ARCHIVED 2026-09-08 — v0.2.28 shipped.** This was the pre-release draft; the
> published notes are on the GitHub release
> (https://github.com/shd101wyy/Yo/releases/tag/v0.2.28), edited in from this
> file because the workflow fills the body from the last commit message only.

Two things land together. **`inout` local bindings and the borrowed `for`** give
the language in-place mutation of locals, fields and collection elements without
a borrow checker — Swift's dynamic exclusivity where the compiler cannot see
statically. And the **std API stabilization campaign's decision batch (D9–D18)**
reshapes the exported signatures to Rust's across twelve PRs.

Alongside them, four silent miscompiles are fixed — **two of them
use-after-free in safe code on the shipped compiler**: a `derive` body that
resolved names in the wrong scope, an interior-`inout` container grown through
an alias (UAF), an alias whose base was reassigned in a nested block (UAF), and
a `return` of an `inout` parameter that emitted a self-dereferencing shadow.
Plus the codegen guard that was supposed to catch this whole class and turned
out to be armed only at `-O0`.

Read the breaking list: this is the batch that changes what your code compiles
to. The campaign record is `plans/STD_API_STABILIZATION.md` §2; the borrow model
is `plans/INOUT_LOCAL_BINDINGS_AUDIT.md` §7–§9.

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

## New — `inout` local bindings and the borrowed `for` (#476)

`plans/INOUT_LOCAL_BINDINGS_AUDIT.md` §7–§8. No borrow checker, no lifetimes; the
keyword stays `inout`.

```rust
x := i32(1);
inout(y) := x;   y = i32(2);   assert(x == i32(2));   // any scope
inout(n) := holder.n;          // field of an RC object: pinned for the scope
inout(px) := p.x;              // field of a value struct
inout(e) := xs(usize(0));      // ERROR: borrow elements with `for`

for(enemies, inout(e) => { e.hp = (e.hp - i32(1)); });   // struct elements in place
for(names, inout(s) => { s.push_str("!"); });            // RC elements, no per-element dup
for(scores, (k, inout(v)) => { v = (v + i32(10)); });    // maps: key by value, value borrowed
for(list, inout(x) => { list.push(x); });                // PANICS — see below
```

Static guarantees where the compiler can see: slot lifetimes by scoping, escape
by the absence of a type, moves by a consume gate, object lifetime by a pin.
Swift-style **dynamic exclusivity** where it cannot — a borrowed loop holds the
collection's `borrow_count`, and every operation that could invalidate an element
asserts on it.

- **Container mutation during a borrowed loop panics.** The asserts are
  **compiler-emitted**, at the entry of every method taking `self` of
  reference-struct type whose body may mutate storage reachable from its
  parameters. Yo has no `mut`, so the body IS the signature: std carries no
  hand-written asserts and third-party collections are covered with no
  annotations. Read-only methods answer "no" and cost nothing.
- v1 limitations: not available inside an `io.async` body that suspends (rejected
  in codegen, pinned as a CLI case), and `inout(e) := xs(i)` on an element is
  rejected — use the borrowed `for`.

## New — std

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

- **An interior `inout` argument whose container is grown through another alias now
  PANICS instead of silently using freed memory** (#473). The runtime borrow-flag
  backstop existed and was exported but was **never called**, so `borrow_count`
  stayed at zero: the documented global-escape residual —
  `g.push(xs); bump(xs(i))` where `bump` grows `xs` through the global — was a
  silent use-after-free **in safe code** (an assert failure at `-O2`, SEGV under
  GuardMalloc). Acquire/release is now wired at every statement-emitting call
  exit, with the release before the deferred drops so an unwinding callee still
  releases. The flag is acquired only on RC-object containers — an indexed
  `Array(T, N)` value has no header.

- **A live "failed to transpile" stub names itself before aborting** (#477).
  Codegen guards these stubs with GNU's `error` attribute so the C toolchain acts
  as the deadness oracle, but that attribute is diagnosed from the backend AFTER
  optimization: at `-O2` — every real build — the call to the `noreturn` stub is
  folded away and it never fired. Measured on one unchanged `.c`: `clang -O0`
  reports it, `clang -O2` does not, and neither `-fno-inline` nor `noinline`
  restores it. A live stub was therefore an rc=134 abort with **no diagnostic
  anywhere**, which is how the derive bug above reached v0.2.27.
  (`issues/fixed/ftt-stub-error-attribute-does-not-fire-at-O2.md`)

- **An alias whose base is reassigned in a nested block no longer frees the
  shared object early** (#476) — a **use-after-free in safe code on the shipped
  compiler**: `h2 := h; { h = new; }; h2.n` released the shared object at the
  inner block's end, because the same-frame alias dup elision did not account
  for the base being reassigned. Also fixes the alias-reassigned leak and the
  chained-alias under-release.
  (`issues/fixed/alias-elision-base-reassigned-in-nested-block-uaf.md`)

- **`return` of an `inout` parameter inside a nested block** emitted a
  self-dereferencing shadow (`int32_t m = (*m);`) (#476).
  (`issues/fixed/inout-return-in-nested-block-shadows-pointer.md`)

## Internal

- **`HashSet(T)` is now a view over `HashMap(T, unit)`** (#471, D16) — 976 → 488
  lines, with one hash/probe/tombstone implementation instead of two. No API change;
  it relies on `unit` being a true ZST since v0.2.26.

## Known issues

- `Url` does not percent-encode components yet.
- `std/fs/watch` stays `unstable` pending its Windows backend.
- `derive` still **swallows** a definition-time body failure. The SILENCE is fixed
  (#477 — the stub now names itself), but the swallow itself remains by design:
  `hard_swallow_diagnostic`'s allow-list exists for legitimate deferrals. `yo check`
  still cannot see it — the marker is a codegen artifact and `check` never runs
  codegen.
- A swallowed exception-handler body ships as an FTT stub in the `tests/http` batch.
  Not reached today, and loud if it ever is
  (`issues/ftt-stub-installed-as-an-exception-handler-in-tests-http.md`).
- `.to_expr()` cannot parse a backtick template literal, and surfaces the failure as
  a misleading "derive rule must return(comptime(Expr))"
  (`issues/comptime-str-to-expr-cannot-parse-a-template-literal.md`).
- `inout` follow-ups, tracked in `plans/INOUT_LOCAL_BINDINGS_AUDIT.md`'s status
  banner: an `Iterable` marker trait (which would also refuse a plain `inout(e)`
  on maps/sets), a compile-time same-variable diagnostic, last-use live ranges,
  the borrowed `for` inside suspending async bodies, and a user-facing codegen
  error channel.
- D18b (`Thread(T)` returning a value) is **blocked** on a compiler fix — either the
  spawn-lowering ZST bug or teaching `_capture_judgement_type` about
  `Impl(Fn, Send)`. Excluded from this release.
