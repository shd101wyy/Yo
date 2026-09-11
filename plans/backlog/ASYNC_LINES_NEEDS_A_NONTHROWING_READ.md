# An async `BufReader.lines` needs a non-throwing read

**Status:** BACKLOG — designed here, blocked on a `Reader` decision. Written
2026-09-11 while implementing `plans/reference/ASYNC_ITERATION_STREAM.md`,
whose "Order of work" item 5 asked for `BufReader.lines` as a `Stream` and
found it is not a stream problem but an error-style one.

## What was wanted

```rust
lines := BufReader(File).new(f).lines();
io.await(lines.for_each(l => println(l), io), io);
```

`std/io/bufio.yo` has said `lines()` is "deliberately absent: Yo has no async
iterator protocol" since D5. That protocol now exists (`std/async/stream.yo`),
so `lines()` should follow — `Channel` and `TcpListener` both gained their
`Stream` impls in the same commit, in three lines each.

## Why it does not follow

`Stream.next` returns `Impl(Future(Option(Self.Item), Io))`. The effect
bundle is **`Io`, not `IoExn`** — deliberately: a stream reports failure IN
the item (`Item = Result(T, E)`), so a consumer needs no `Exception` handler
and one bad item does not end the sequence. That is the decision the whole
trait rests on.

`BufReader.read_line` reports failure the other way — it THROWS
(`Impl(Future(Option(String), IoExn))`), like every method on the `io` path
(D1 style 1). So a `Lines(R)` stream would have to turn a throw into a value,
and there is no way to do that inside the `next` body:

- **Installing a handler inside the async body is out.** A `ctl` handler is
  frame-bound (`docs/en-US/ALGEBRAIC_EFFECTS.md`), and `unwind` inside an
  `io.async` body is memory-unsafe; a handler that RESUMES instead would let
  `read_line` continue past its own failure with a fabricated value.
- **Storing the caller's handler in the stream is out.** A `ref(struct(_exn :
  Exception))` is rejected — pointers/references to control-bound types are
  illegal precisely so handlers cannot outlive their install frame.
- **Re-reading the bytes by hand does not help.** The primitive underneath is
  `Reader.read`, which throws too.

So the missing piece is a read primitive that returns its failure.

## Options

1. **Invert the `Reader` primitive (RECOMMENDED).** Make the required method
   `try_read(self, buf, size, io) -> Impl(Future(Result(usize, IoError), Io))`
   and make today's throwing `read` a trait DEFAULT over it (`match(.Err(e)
   => e.exn.throw(dyn(e)))`). Failure-as-a-value becomes the primitive and
   throwing becomes the convenience, which is the same direction `Stream`
   already took. Then `Lines(R)` is a dozen lines with
   `Item = Result(String, IoError)`.
   Cost: every `Reader` implementor's primitive changes — `File`,
   `TcpStream`, `Stdin`, `BufReader(R)` itself, `Dyn(Reader)`'s vtable — and
   `std/io` is a STABLE module, so this needs the deprecation discipline of
   `yo-design.instructions.md` ("Additive = …"): ship `try_read` as an
   optional trait method with a default that wraps `read`, migrate the four
   implementors, then flip which one is required.
2. **Add `try_read` as a SECOND primitive** (both required, no default).
   Simpler to reason about, but it puts two spellings of one operation in a
   stable trait — the thing D2 exists to prevent.
3. **Give `Lines(R)` an `Item = String` and let it swallow errors** (a read
   failure ends the stream, indistinguishable from EOF). Rejected: it is the
   `Option`-instead-of-`Result` collapse D18 removed from `timeout` and D7
   removed from `try_recv`; a truncated file would read as a complete one.
4. **A language feature: catch an effect as a value across a suspension**
   (a `try`-shaped handler usable inside an async body). The general fix, and
   much larger than this API. If it lands, option 1 stops being necessary —
   but option 1 is worth doing anyway, because failure-in-the-item is the
   better shape for a byte source.

## Recommendation

Option 1, as its own PR against `std/io`, sequenced as: add `try_read` with a
`read`-based default (additive, nothing breaks) → migrate `File`,
`TcpStream`, `Stdin`, `BufReader` to implement `try_read` natively and take
`read`'s default → add `Lines(R)` with `Item = Result(String, IoError)` and
`BufReader.lines()` → drop `read`'s requirement in the release after.

Until then `read_line` in a `while` loop is the line reader, and
`std/io/bufio.yo`'s doc keeps saying so — with this doc as the reason, instead
of the now-stale "Yo has no async iterator protocol".

## Cross-references

- `plans/reference/ASYNC_ITERATION_STREAM.md` — the trait and why its future
  is `Io`-only.
- `plans/STD_API_STABILIZATION.md` §4 (I/O) — the std campaign's I/O section.
- `std/io/index.yo` — `Reader`/`Writer`; the `?=` default syntax this plan
  leans on is already used there twice.
