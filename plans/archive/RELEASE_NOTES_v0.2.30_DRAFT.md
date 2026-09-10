# v0.2.30

> **ARCHIVED 2026-09-10 — v0.2.30 shipped.** This was the pre-release draft;
> the published notes are on the GitHub release
> (https://github.com/shd101wyy/Yo/releases/tag/v0.2.30), edited in from this
> file because the workflow fills the body from the last commit message only.
> 13 assets, `SEED_VERSION` auto-bumped to v0.2.30 — which is what unblocks the
> std half of `Mutex.try_lock` / `Condvar.wait_timeout` / `RwLock.try_*`.

**`open(...)` is gone from the language.** That is a breaking change in a patch
release, and it is the first thing to know: every glob import becomes a named
import. The rest of the release is the std API stabilization campaign's I/O,
encoding and concurrency groups, plus the runtime half of the sync primitives
that `std/` will call one release from now.

## Breaking

### `open(...)` is removed (#530)

`open(import("std/string"));` no longer compiles. Write what you use:

```rust
{ String } :: import("std/string");
{ eprintln, println } :: import("std/fmt");
```

Struct opens become the existing runtime destructuring, `{ x, y } := s`. The
builtin, its evaluator and codegen handlers, its test and its keyword are all
deleted. The design record, including the migration rules and the findings from
converting the tree, is `plans/reference/REMOVE_OPEN_BUILTIN.md`.

Two things that bite during migration:

- **A bare `import("std/fmt");` binds NOTHING.** It is a side-effect import. If
  a mechanical conversion leaves you with one, the file compiles until it uses
  a name from that module and then fails with `Variable "eprintln" not found`.
- A `derive(Error)` / `derive(ToString)` call site still needs `String` and
  `ToString` reachable, because the derived body is unhygienic. A named
  `{ String } :: import(...)` satisfies it.

The vendored `markdown_yo` has its companion commit
(shd101wyy/markdown_yo@a46f700); if you vendor Yo code of your own, it needs
the same treatment before it will build against this release.

### `HttpResponse.status_code : i32` is now `status : StatusCode` (#524)

`resp.status_code == i32(404)` becomes `resp.status == StatusCode.NOT_FOUND()`,
and `http_status_text(code)` becomes `status.reason()`. See below for why.

### `UdpSocket.recv_from` lost its out-params (#524)

It resolves to `(usize, SocketAddr)` instead of taking
`src_addr : *u8, src_addr_len : *u32`.

### `EncodingError` variants carry positions (#526)

`InvalidChar(ch)` is now `InvalidChar(ch, pos)`, `OddLength` is
`OddLength(len)`, `InvalidLength` is `InvalidLength(len)`, and
`InvalidLastSymbol(ch)` is `InvalidLastSymbol(ch, pos)`.

## Highlights

### The sync primitives the runtime was missing (#529)

`__yo_mutex_trylock` and `__yo_cond_timedwait` are in the emitted runtime. This
is the **compiler half** — `std/` cannot call a new `__yo_*` primitive until a
seed ships it, which is what this release does, so `Mutex.try_lock`,
`Condvar.wait_timeout` and `RwLock.try_*` land in the release after this one.

Three platform shapes, each for a reason. Windows rounds the timeout **up** to
the next millisecond, because `SleepConditionVariableCS` takes milliseconds and
truncating a sub-millisecond timeout to 0 makes it return immediately — a
"wait 100 us" would never wait at all. macOS uses
`pthread_cond_timedwait_relative_np`: it has no `pthread_condattr_setclock`,
and the relative form needs no deadline arithmetic. Linux binds the condvar to
`CLOCK_MONOTONIC` at init and reads the deadline from the same clock, so a
wall-clock step cannot lengthen or cut short a wait — the clock is a property
of the *condvar*, not of the wait, so the two must agree.

`tests/sync/timedwait.test.yo` exercises both a release before `std/` can call
them, because a `static inline` with no caller gets nothing but a syntax check.
Its timeout test asserts **elapsed time**, not just the return value: a
deadline whose `tv_nsec` escapes `[0, 1e9)` makes `pthread_cond_timedwait`
return `EINVAL` immediately, which is indistinguishable from a timeout by
return value alone.

### I/O — `Seek`, `OpenOptions`, `SystemTime` (#522)

`SystemTime` + `UNIX_EPOCH` are a **second clock**, deliberately not
interconvertible with `Instant`. `Instant` reads `CLOCK_MONOTONIC` (no epoch,
never steps, only differences mean anything); `SystemTime` reads
`CLOCK_REALTIME` (anchored at the epoch, steppable by NTP or by hand).
`duration_since` returns `Result(Duration, SystemTimeError)` — Rust's shape —
because a backwards step is a real outcome, not a bug to swallow. All of its
arithmetic stays on the `(secs, nanos)` pair: converting either side to a
single `i64` nanosecond count overflows past year 2262, and signed overflow is
UB in C.

`Metadata.modified` / `accessed` / `status_changed` return `SystemTime` built
from `statx`'s seconds **and** nanoseconds — the seconds-only accessors were
discarding `mtime_nsec` outright, and are kept for callers that want the raw
field.

The `Seek` trait is **synchronous** while `Reader`/`Writer` are async, because
moving a position is arithmetic on a handle's own state: `File`'s reads and
writes are positional, so its descriptor sits at offset 0 forever and
`File.seek` never touches it. It has no `rewind`, unlike Rust: every absolute
move needs a `From` *value* naming the beginning, and a trait generic over
`From` cannot name one, so the convenience is inherent on `File`.

`OpenOptions` is a value struct with functional setters. It exists because
`OpenMode`'s five variants cannot express read+append, create-without-truncate,
or read+write+create. `to_flags()` **rejects** the four combinations POSIX does
not diagnose — no access mode, `truncate` without write access, `truncate` with
`append`, `create` without write access — because `open(2)` quietly ignores
whichever flag does not apply and hands back a file that behaves differently
from what was asked.

### Networking and HTTP (#524)

`IpAddr.parse_v6` takes all three RFC 4291 §2.2 forms and rejects, each with
its own message, two `::` runs, over-long groups, a bare leading or trailing
`:`, a dotted-quad that is not a valid IPv4 address, a `::` in an address that
already spells eight groups, and a zone id. `IpAddr.parse` dispatches on
whether the text contains a `:` — exact, so a malformed address reports the
error for the family it was clearly meant to be.

`SocketAddr.parse` requires brackets for a V6 host: a bare `::1:80` is
ambiguous about whether `80` is the port, which is exactly why RFC 3986 §3.2.2
introduced them. Its port parser range-checks as it goes, because
`parse_i32("70000")` succeeds and a `u16` cast would silently make it 4464.

Plus `any_v6`, `octets`, `segments`, `is_unspecified`, `is_multicast`,
`is_private`, `is_unique_local`, `is_link_local`. `is_private` is RFC 1918
**only** — `fc00::/7` has different routing rules, so it is a separate
predicate; conflating them is how an access check ends up wrong.

`StatusCode` is a `u16` newtype with the class predicates, 34 reason phrases
and 22 named codes as nullary constructors — not enum variants, because the set
is open. `HeaderMap` replaces `ArrayList(HttpHeader)`: names compare
case-insensitively while being stored as written, and a field may repeat with
the order significant, so it is an insertion-ordered multimap.

Three bugs fell out of that rework: `parse_response` accepted a status outside
100–599, rejected a status line with no reason phrase (which RFC 9112 §4.1
makes optional), and rebuilt the body by splitting the whole message on CRLF
and re-joining it one concatenation at a time — quadratic, and a `substring`
over a UTF-8 continuation byte panics.

Also: a program without `pragma(Pragma.AllowUnsafe)` could **send** a datagram
and not receive one, because every receive took a `*(u8)`. `recv_bytes` and
`recv_from_bytes` close that.

### Encoding (#526)

Every `Url` component setter — `set_scheme`, `set_host`, `set_port`,
`set_path`, `set_query`, `set_fragment`, `set_userinfo` — and all but
`set_port` are **fallible**, which is the point. `Url.parse` rejects any byte
outside RFC 3986 §2 as a security boundary: a raw CRLF in a path flows through
`Url.path()` into `HttpRequest`'s request line and splits one HTTP request into
two. A setter that skipped the check would be a hole straight past the parser.

`EncodingError` now says **where**. The new
`UnpairedSurrogate(code_unit, pos)` replaces a wrong value rather than a thin
one: all three surrogate faults in `utf16_to_utf8` reported `InvalidChar(0)` —
an offending character of NUL — because a UTF-16 code unit is 16 bits and
`InvalidChar`'s `ch` is a `u8`.

### Concurrency (#532)

`interval` — a repeating tick that does **not** drift. `while(true, { work();
sleep(period); })` takes `period + work` per iteration, so 100 ticks of 10 ms
work on a 1 s period ends a second behind; an interval anchors each tick to a
schedule instead. Missed ticks burst, as Tokio's default does.

`Once.call` runs its slow path under `Mutex.with_lock`. The long-standing note
asking for that said the manual lock/unlock pair could leave the mutex held
forever if the initializer unwound — **that was wrong, and is corrected in
place**: a closure cannot capture an `Exception`, so the initializer has no way
to throw past that frame.

`Mutex` has concurrent tests for the first time. Every previous test in that
file was single-threaded, so none of them could tell a working `Mutex` from a
no-op.

## Fixes

- **`derive` reports a rule's own error** instead of a generic message (#518) —
  which is why several of the bugs above were findable at all.
- **A failed prelude load** printed twice and continued (#516).
- **A tripped evaluator deadline** was masked by a bogus type error blaming
  innocent prelude code (#520).
- `midpoint` and `isqrt` overflowed at the extremes (#520).
- `crypto/random.random_range` returned `min` for an empty range — a value
  never in the range (#515) — plus signed-overflow UB at five span sites.
- **A tuple type had no forward declaration** (#507), so
  `ArrayList(Tuple(A, B))` emitted `unknown type name '__yo_t2'`.
- **A self-referential pattern binding** was miscompiled (#527, C11 6.2.1p4).
- **A unit operand read as a failed transpile** (#498).
- `typeid`'s diagnostic told you to `Use is() or downcast()`, and **there is no
  `is()` in the language** (#522).

## CI

One broken third-party apt source was taking out every Linux job (#531).
`apt-get update` exits 100 if *any* configured source fails, and a Hash Sum
mismatch on the runner image's Google Chrome list produced 18 red checks across
three PRs — most of them reported as "Artifact not found" on legs that never
ran apt. `Acquire::Retries` cannot help: a hash mismatch is deterministic. The
image's third-party lists are now pruned before each update, at all 20 call
sites.

## Known issues

- `ErrorChain` / `root_cause` remain blocked on a compiler defect, not on
  design: `Dyn(SelfTrait)` in a return type loses the trait on an erased
  receiver (`issues/self-trait-in-a-return-type-loses-the-trait-on-an-erased-receiver.md`).
- A `derive` body cannot bind a field named after a builtin type — the derived
  body is unhygienic, so a field called `unit` fails with a confusing
  `Argument count mismatch: expected 1, got 0`
  (`issues/derive-body-field-name-collides-with-a-builtin-type.md`).
- `yield` resumption order has twice diverged on macOS CI legs
  (`issues/yield-resumption-order-diverges-on-macos-ci.md`). The ready queue is
  strict FIFO, so the issue's original fix is refuted; three candidates remain.
