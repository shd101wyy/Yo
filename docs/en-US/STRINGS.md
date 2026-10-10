# Strings: the byte-indexed contract

Yo strings are UTF-8, and **every string index is a byte offset** — the same
model as Rust and Go. This holds across all the string types you meet in
ordinary code and at compile time:

| type | `len()` | slicing | element access |
| --- | --- | --- | --- |
| `String` (`std/string`) | bytes, O(1) | `substring(a, b)` — bytes | `byte_at(i)` → `u8`, `get_byte(i)` → `Option(u8)`, `at(i)` → `Option(rune)` |
| `str` (prelude; string literals) | bytes | `s(a..b)` — zero-copy byte window | `bytes(i)` → `u8` (aborts out of range) |
| `StringBuilder` (`std/string`) | bytes | — | — |
| `comptime_str` (compile time) | bytes | `slice(a, b)` / `s(a..b)` — bytes | `s(i)` → 1-rune `comptime_str` |

`str` and `StringBuilder` were always byte-based; `String` joined them in the
D4 migration (2026-08-26, `plans/archive/STD_API_AUDIT_D4_PLAN.md`), and the comptime
string operations were aligned in the same campaign. There is one
string-indexing story.

## The one rule

An index into a string names a **byte**, and every index a string method
accepts or returns must sit on a **UTF-8 character boundary** (the first byte
of a rune, or `len()`). ASCII text is unaffected — every byte is a boundary.

```yo
{ String } :: import("std/string");

//        a=1B @0   é=2B @1   中=3B @3   𝄞=4B @6   — 10 bytes, 4 runes
s := String.from("aé中𝄞");
s.len(); // usize(10) — BYTES, O(1)
s.chars().count(); // usize(4)  — runes, O(n)
s.substring(usize(3), usize(6)); // "中" — byte range [3, 6)
s.index_of(String.from("中")); // .Some(usize(3)) — a byte offset,
//   feed it straight back into substring
```

`index_of`, `last_index_of`, the `s(a..b)` / `s(a..=b)` range sugar, and the
optional positional arguments of `contains` / `starts_with` / `ends_with` all
speak the same unit. So do the `Pattern` trait's methods.

## Boundary policy

Stated once, on `substring`, and it applies to the `s(a..b)` sugar too:

- **Out-of-range CLAMPS.** An endpoint past `len()` is pulled back to `len()`,
  and `start >= end` yields the empty string. This clamp is intended, tested
  behavior — not an accident to be "fixed" (safe-mode D5).
- **A non-boundary index PANICS.** An endpoint inside a rune is a programmer
  error — a byte offset that came from the wrong basis — not a range
  condition, and honouring it would hand back invalid UTF-8.
- **`try_substring(a, b)`** is the non-panicking form: `.None` for `a > b`,
  `b > len()`, or an endpoint inside a rune (Rust's `s.get(a..b)`).
- **`floor_char_boundary(i)` / `ceil_char_boundary(i)`** snap an arbitrary
  byte offset back/forward onto a boundary (clamped to `len()`), for callers
  doing byte arithmetic.
- **`is_char_boundary(i)`** answers the question directly: `0` and `len()`
  are boundaries; an index past the end never is.

```yo
s := String.from("aé中𝄞");
s.substring(usize(1), usize(2)); // PANICS — byte 2 is inside é
s.try_substring(usize(1), usize(2)); // .None — same range, refused politely
s.floor_char_boundary(usize(2)); // usize(1) — snap back to é's start
s.substring(usize(0), usize(99)); // "aé中𝄞" — out-of-range clamps
```

`at(i)` decodes the rune **starting** at byte `i` and answers `.None` for the
three ways a byte offset can fail to name one: at or past `len()`, on a
continuation byte, or on bytes that do not decode. A `while(i < s.len())`
loop over `at(i)` therefore visits continuation bytes — iterate runes with
`chars()` / `char_indices()` instead.

## Search methods never panic — with one pinned exception

`index_of` / `last_index_of` / `contains` / `starts_with` / `ends_with` do
not boundary-check their positional arguments, deliberately: UTF-8 is
self-synchronizing, so a valid-UTF-8 needle can never match starting at a
continuation byte. A mid-rune `from_index` / `position` cannot invent a hit;
it simply answers `false` / `.None`. For a non-empty needle, every index these
methods return is a rune boundary.

**The empty needle is the exception, and its behaviour is pinned:**

- `index_of("", i)` returns `.Some(i)` **verbatim, unvalidated** — including
  an `i` inside a rune and an `i` past `len()`. (JavaScript's `indexOf("")`
  clamps to the length; this does not, and neither did the pre-D4 version.)
- `last_index_of("", i)` returns `len()` regardless of `i` (Rust's
  `rfind("")` shape), so it is the one case where the result can exceed the
  cap the caller asked for.

An offset past the end is harmless downstream because `substring` clamps, but
a mid-rune one panics there. A caller that feeds a search result straight back
into a slice **and** can be handed an empty needle should go through
`try_substring`, or snap with `floor_char_boundary`.

## Rune work: iterators, not char indices

There is no char-indexed slicing in the API. Rune work composes `chars()` /
`char_indices()` with iterator methods:

```yo
s := String.from("aé中𝄞");

// The rune count. O(n) — the iterator spelling keeps that cost visible at
// the call site (`len()` is O(1) everywhere in std; Rust reserves `len()`
// for ExactSizeIterator, which a chars iterator is not).
n := s.chars().count(); // usize(4)
// Walk runes with their byte offsets: p._0 = byte offset, p._1 = rune.
for(s.char_indices(), p => { ... });

// Truncate to at most n runes: the byte offset where rune n starts is the
// cut point; fewer than n+1 runes means keep the whole string.
cut := match(
  s.char_indices().nth(usize(2)),
  .Some(p) => s.substring(usize(0), p._0),
  .None => s
); // "aé"
// First rune + the rest.
first := s.chars().next(); // Option(rune)
```

`chars()` and `char_indices()` sit on `std/encoding/utf8` and inherit its
malformed-input behaviour: they stop at the first sequence that will not
decode.

(The one-shot methods this replaced — `bytes_len()`, `char_len()`,
`char_substring()` and `truncate_chars()` — were removed on 2026-08-26;
`len()` and the idioms above are the whole vocabulary.)

## Element access: `byte_at(i)`, not `s(i)`

`byte_at(i)` returns the **byte** at offset `i` as a `u8` — byte-level access
into the UTF-8 buffer, no boundary requirement — and panics past the end.
`get_byte(i)` is the checked form: `.None` past the end (Rust's
`s.as_bytes().get(i)`). Both read the string in place. Decoding is `at(i)`.

A runtime `String` has no `s(i)`: it does not implement `Index(usize)`, so
`s(usize(0))` is E0606 ("s is not callable"). `Index` hands out a writable
place, and a write through it (`s(i) = b`) would reach every string sharing
the buffer and could leave invalid UTF-8 behind. A read-only `s(i)` returns once
`Index` separates reads from writes. The range sugar `s(a..b)` is unaffected:
it builds a new string.

```yo
{ String } :: import("std/string");

s := String.from("aé中");
s.byte_at(usize(0)); // u8(97)
s.get_byte(usize(9)); // .None — past the end
s(usize(1) .. usize(3)); // "é" — a new String
```

## Copies, clones and the byte list

Every mutator (`push_str`, `push_string`, `push_byte`, `push_rune`,
`reserve`, `clear`, `truncate`, `insert_str`, `insert`, `remove`, `pop`)
takes `mut(self)` and writes in place. `clone()` copies the bytes (O(n));
the clone is independent of the original, empty or not. A plain copy
(`t := s`) still shares a non-empty buffer until `plans/VALUES_BY_DEFAULT.md`
V2b makes `String` uniquely owned (then `t := s` is a move, or an error naming
`s.clone()`), so write only through a clone. Writing through a borrowed copy
(a by-value parameter, a `for` or `match` binding) is E0908; the rules are in
[DESIGN.md](./DESIGN.md#writing-through-a-copy-of-a-string).

Nothing outside a `String` may write its buffer, so the byte list is copied or
moved, never lent:

| method | result |
| --- | --- |
| `to_bytes()` | a new, independent `ArrayList(u8)`, O(n) |
| `into_bytes()` | consumes the string and moves its buffer out; copies only when another copy shares it |
| `String.from_bytes(sink(bytes))` | takes the list over, unchecked |
| `String.from_utf8(sink(bytes))` | takes the list over after validating it; `Err(.InvalidUtf8(...))` otherwise |

To read bytes, use `len()`, `byte_at(i)`, `get_byte(i)` or the `bytes()`
iterator, which copy nothing.

## Compile-time strings share the basis

Since D4 PR 7 the `comptime_str` operations are byte-based too:

```yo
s :: "aé中𝄞";
comptime_assert(s.len() == 10); // bytes, like the runtime len()
comptime_assert(s.slice(3, 6) == "中"); // byte offsets, like substring
comptime_assert(s(1) == "é"); // the rune STARTING at byte 1
comptime_assert(s(3 .. 6) == "中"); // byte range
```

Two comptime-specific points:

- **A mid-rune offset is a compile error**, not a panic — the compiler
  rejects `s(2)` on the string above ("not on a UTF-8 character boundary")
  instead of aborting. Out-of-range indexing is a compile error too;
  `slice` clamps out-of-range, as it always has.
- **`s(i)` yields a 1-rune `comptime_str`, not a byte.** A comptime string is
  text, not a byte buffer, so comptime `s(i)` mirrors the runtime `at(i)`
  (the rune starting at byte `i`) rather than the runtime `byte_at(i)` (the
  `u8`); a runtime `String` has no `s(i)` at all. This result-type split
  predates the byte migration and is deliberate.

## Practical rules

- A byte loop bounds with `len()` and reads with `byte_at(i)` — the bases
  agree by construction now.
- Whatever `index_of` returns goes straight back into `substring` (empty
  needle aside — see above).
- Never do arithmetic like "index + 1 rune" in bytes; use `char_indices()`
  or `ceil_char_boundary`.
- When you mean "how many characters", say `s.chars().count()`. When you
  mean "how big is the buffer", say `s.len()`.
- `Content-Length`-style protocol fields count bytes; `len()` is now the
  right answer by default.
