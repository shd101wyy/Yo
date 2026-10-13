# `Hash.hash`, `Debug.debug_string`, `Format.format`, `ToJson.to_json` and `Error.source` take `self : &mut Self`, so an element read through `&` cannot call them after the `Index` split (DECIDED)

**Kind:** design decision, the follow-up audit that
`issues/fixed/clone-and-to-string-take-their-receiver-mutably.md` asked for.
Filed and decided 2026-10-13 (branch feat/vbd-readonly-receivers, stacked on
#1333).

**Verdict (2026-10-13):** the five methods, and `Hasher.finish`, take
`self : &Self`, as Rust's `Hash::hash(&self, ..)`, `Hasher::finish(&self)`, `Debug::fmt(&self, ..)`, `Display::fmt(&self, ..)`,
`Serialize::serialize(&self, ..)` and `Error::source(&self)` do. Every other
trait method in std that takes `self : &mut Self` really writes its receiver
and keeps it.

## The hole

The same one as `Clone`/`ToString`. Once `Index` is the read projection
`self : &Self -> &Self.Output` (decision 34, V2b Generation B), calling a
`self : &mut Self` method on `xs(i)` dispatches `index_mut`, and on a
container reached through a `&` borrow that is E0908. A generic body has the
hole today, with no `Index` involved: `fn(x : &T, where(T <: Hash))` calling
`x.hash(&mut h)` is E0908 ("Cannot pass `x` as the `self : &mut Self`
receiver: `x` is a `&T` parameter"), and `json.encode(v : &T)` reaches
`v.to_json()` the same way.

## Audit

Every `trait(...)` in `std/` with a receiver, by method:

| Trait | Method | Was | Now | Why |
| --- | --- | --- | --- | --- |
| `Hash` (prelude) | `hash` | `&mut Self` | `&Self` | feeds the receiver's bytes into the hasher; the hasher is the `&mut` |
| `Debug` (`std/fmt/to_string.yo`) | `debug_string` | `&mut Self` | `&Self` | renders |
| `Format` (`std/fmt/format.yo`) | `format` | `&mut Self` | `&Self` | renders; its default calls `to_string`, already `&Self` |
| `ToJson` (`std/encoding/json.yo`) | `to_json` | `&mut Self` | `&Self` | builds a new `JsonValue` |
| `Error` (`std/error.yo`) | `source` | `&mut Self` | `&Self` | hands back the wrapped cause |
| `Hasher` (prelude) | `finish` | `&mut Self` | `&Self` | reads the state: `SipHasher13` finalizes on a local copy, `Fnv1aHasher` returns its field (Rust's `Hasher::finish(&self)`); the `Digest` finishes in `std/crypto` already took `&Self` |
| `Hasher` (prelude) | `write`, `write_*` | `&mut Self` | kept | absorb bytes into the state |
| `Iterator` / `DoubleEndedIterator` | `next`, `next_back` | `&mut Self` | kept | advance the cursor |
| `log.Sink` (`std/log.yo`) | `write_line` | `&mut Self` | kept | a sink accumulates (`tests/log_sink_env.test.yo` pushes onto `self.lines`); it runs under the log mutex, never through `Index` |
| `Index(Idx)`, `IndexUnchecked`, `ComptimeIndex(Idx)` | `index`, `index_unchecked` | `&mut Self` | not touched | V2b's own change: `Index` becomes the read projection and `IndexMut` the write half in Generation B (decision 34) |
| `Clone`, `ToString` | | | `&Self` | #1333 |
| `Eq`, `Ord` | operators | `lhs : &Self` | | already read-only |
| `Reader`, `Writer`, `Seek`, `Stream`, `Digest`, `Pattern`, `IntoIterator`, `Isolation`, `Dispose`, `Trace` | | `&Self` | | already read-only |
| arithmetic, bitwise, unary operator traits | | by value | | decision 34 as amended 2026-10-11 |
| `ComptimeToString`, `From`, `Into`, `FromJson`, `FromString`, `Default` | | no receiver or `comptime(self) : Self` | | |

No impl body wrote its receiver. `hash_one` and `hash_one_with_keys`
(`std/hash.yo`) and `HashMap._hash` took `value : &mut T` / `key : &mut K`
only to call `hash`; they now take `&T` / `&K`, and their callers pass `&x`.

## Sweep

- The trait declarations and every impl that spelled the receiver in `std/`
  (the primitive, `Array`, `Option`, `Result`, `Rc`, `Box`, `String`, `Path`,
  `IpAddr`, `SocketAddr`, `Duration` hashes; the two `Hasher.finish`es; the
  primitive `Debug`s; the numeric `Format`s; the `ToJson` impls;
  `Context.source`), `tests/encoding/json.test.yo` and the test hasher in
  `tests/hash.test.yo`.
- `derive(Hash)` spells its member `self : &Self` and a `Deref` field's hash
  `(type_of(self.f) <: Hash).hash(&self.f, hasher)`. `derive(Debug)`,
  `derive(ToJson)` and `derive(Error)` write an unannotated `self -> ...`
  member and take the trait's mode with no edit.
- `hash_one(&mut x)` call sites in `src/` and `tests/` became `hash_one(&x)`.
- Unlike #1333, no body used `__yo_return_self`; the primitive bodies read
  `self` as a value (`hasher.write_i8(self)`, `u64(self)`), which a by-value
  `&Self` scalar is.

## Tests

`tests/parameter_modes.test.yo`: "Hash, Debug, Format, ToJson and
Error.source read a & borrow" (generic `&T` helpers; E0908 against the old
std) and "Hash, Debug, Format, ToJson and Error impls may not take self :
&mut Self" (the `_receiver_writes_where_trait_reads` rule; no error against
the old std, where the traits lent `&mut`). The `Hash` case covers a member
with its own `generic(H)`.
