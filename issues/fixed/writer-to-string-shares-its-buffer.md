# `StringBuilder.to_string` copied the buffer out byte-by-byte

**Status: FIXED** (2026-09-09).

Not a correctness bug — it already detached, so a returned `String` was
independent, which is what
`issues/fixed/fmt-writer-to-string-aliases-the-live-buffer.md` fixed for
`Writer`. This is the COST.

`StringBuilder.to_string` allocated a second `ArrayList` and copied every byte
across through `self._buf.get(i)` — an `Option`-returning bounds-checked read
per byte — before resetting:

```rust
buf := ArrayList(u8).with_capacity(n);
i := usize(0);
while(i < n, i = (i + usize(1)), {
  match(self._buf.get(i), .Some(b) => { buf.push(b); }, .None => ());
});
self._buf = ArrayList(u8).new();
```

So building an N-byte string cost O(N) to build and O(N) again to read out,
with a branch per byte. `Writer` had already solved this the right way — hand
the whole `ArrayList` over and start fresh:

```rust
bytes := self._buf;
self._buf = ArrayList(u8).new();
String.from_bytes(bytes)
```

`StringBuilder` inherited that when `Writer` was retired into it. The
detach-semantics test moved across with it, so the property that mattered —
a later write never mutates a `String` already handed to a caller — is still
pinned.
