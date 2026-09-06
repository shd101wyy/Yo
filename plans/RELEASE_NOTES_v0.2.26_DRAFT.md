# v0.2.26

A small, deliberate release: **`unit` is now a true zero-sized type**, the
lazy-binding campaign closes with forward references allowed in `std/` and
`src/` themselves, and Windows regains a TLS backend (Schannel) — compiled and
linked on the Windows runners, with its live suites still gated off there until
the handshake is proven.

## ⚠️ Breaking changes (patch-release policy)

- **`sizeof(unit)` is 0, and a `unit` field costs nothing** (#437). A `unit`
  struct/tuple field emits no C member, an enum variant field is erased,
  `Array(unit, N)` has no data. `struct(a : i32, b : unit)` is **4** bytes
  (was 8), `Tuple(i32, unit)` is **4**. An aggregate whose EVERY field is
  `unit` is **1 byte** (one `_zst_dummy` member) — not 0: an empty C struct is
  4 bytes on the MSVC ABI and 0 on GNU, so it is not a portable representation
  (measured; the first cut crashed both Windows CI legs). This is
  Rust's model (`size_of::<()>() == 0`). **`sizeof(unit)` has now moved
  0 → 1 → 0 across v0.2.24 → v0.2.25 → v0.2.26**: the 1 in v0.2.25 was the safe
  stopgap for a live heap overflow and could not wait; this release is the
  erasure that makes 0 right. The one place a `unit` still occupies a byte is a
  by-value *parameter* (C cannot declare a `void` parameter) — calling
  convention, not layout; `sizeof` never observes it.
- **`ArrayList` of a zero-sized element type allocates one anchor byte per
  list and reports `SIZE_MAX` capacity** (#437). It never resizes. Rust's
  `Vec<()>` never allocates at all; Yo cannot form a non-null dangling
  pointer, and routing a zero-byte request through the allocator is
  `malloc(0)` then `realloc(p, 0)` — which frees `p` and returns NULL on glibc
  and the Windows CRT.

- **std API stabilization, P0 sweep** (`plans/STD_API_STABILIZATION.md`,
  #444–#454). These follow Rust's shapes and change signatures:
  - `Path.strip_prefix(base)` is now Rust's: `Option(Path)` — the remainder when
    `base` is a segment-wise prefix, `.None` otherwise. The old behaviour
    (node's `path.relative`, with `..` segments) is `Path.relative_to(base)`.
  - `Thread` is a reference type with `JoinHandle` semantics: `join` twice
    panics; dropping an un-joined handle DETACHES the thread. `Thread.is_joined()` added.
  - `BTreeMap.insert` returns `Option(V)` (the replaced value) instead of `unit`.
  - `Child.kill(signum, exn)` throws the errno as an `IoError` instead of
    returning a raw `-errno` `i32`.
  - `http.parse_request` / `parse_response` return `Result(_, HttpParseError)`
    instead of `Result(_, String)`; `read_http_message` returns
    `Result(String, HttpError)` and the server answers 413/400 instead of dying.
  - `base64_decode` rejects a length of 1 mod 4 and non-canonical trailing bits
    (`EncodingError.InvalidLength` / `InvalidLastSymbol`).
  - `Rng.range(x, x)` and `Rng.next_below(0)` panic (they divided by zero).
  - `fmt.Writer.to_string` hands over the buffer and leaves the writer empty.
  - `DateTime.now()` is really local (zone offset from the C library).
  - **`Send` is enforced at spawn boundaries**: a `Thread.spawn` / `spawn(pool, …)`
    closure that captures a non-`Send` value (an `ArrayList`, a `String`, any
    plain `ref(struct)`, an `Io`, a `JoinHandle`) is now a compile error —
    wrap it in `Arc`/`Iso` or capture a `Send` projection. A captured closure
    is judged by its own captures.

## Language

- **Forward references are now allowed in `std/` and `src/` themselves** (#438,
  P5 — the last phase of `plans/reference/LAZY_TOPLEVEL_BINDINGS.md`). The
  "seed gate" that kept the standard library and the compiler on
  definition-before-use is lifted now that the seed (v0.2.25) carries P1–P3;
  the first forward references land in `module_manager.yo` and the type
  synthesizer, replacing two IIFE-wired function-pointer slots that only
  existed to express mutual recursion. `yo explain E0401` / `E0906` texts that
  still described the old rule are rewritten with examples that still fail.
- **`unit` implements `Eq`, `Ord`, `Hash` and `Clone`** (#437), as Rust's `()`
  does. Note: infix `==` on two `unit` operands does not yet dispatch to that
  impl (a pre-existing gap in the operator fall-through, tracked in
  `issues/equality-operator-without-an-eq-impl-evaluates-to-unit.md`), so
  `derive(Eq)` over a struct with a `unit` field still does not work.

## Platforms

- **Windows: the Schannel TLS backend is back** (#442, re-landing #413). It
  compiles and links on both Windows runners and `tls_available()` is observable
  there. **The TLS and HTTP test suites remain skipped on Windows in this
  release**: the first attempt ran them against the brand-new backend and the
  Windows legs hung for the 4-hour job timeout with no log to read. They are
  un-skipped in a follow-up with a per-test deadline on every network test.
  Windows `test` legs now carry a 75-minute budget so a hang produces a failed
  job with a downloadable log.

## Correctness

- **An enum with no non-unit variant field was 8 bytes on Windows against a
  layout model of 4** (#437, pre-existing). Its data union was empty, and an
  empty union is 4 bytes on the MSVC ABI (0 on GNU), so every container of an
  `Option(unit)`-shaped enum was under-allocated on Windows. Such an enum now
  emits no data union at all: it is its tag, 4 bytes on every target.
- **`cond` with a comptime-true condition in a non-first arm emitted a dangling
  `else`** (#437). The arm was written as a bare `else { … }` but the chain kept
  going and wrote the next arm as a second `else` — invalid C. Any `cond`
  mixing a runtime guard with a type-level fact (`sizeof(T) == usize(0)` in a
  generic body) hit it. The chain now stops after a comptime-true arm.

## Testing

- `tests/unit_as_value_type.test.yo` pins every unit-bearing shape's size
  against the *emitted* layout with a differential round trip, plus
  `ArrayList(unit)` to 1000 elements, an all-unit struct to 300, a `ref` struct
  with a unit field between an `i32` and a `String`, `HashMap(String, unit)`,
  a generic struct at `T = unit`, `Array(unit, 3)`, and a *counted*
  side-effecting unit constructor argument (#437).
