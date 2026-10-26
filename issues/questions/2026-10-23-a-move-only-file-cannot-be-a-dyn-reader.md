# With move-only resources there is no `Dyn(Reader)` or `Dyn(Writer)`

**Kind:** design question — an open decision, not a defect.

**Status:** OPEN — found 2026-10-23 while moving the std resources to move-only values (plans/VALUES_BY_DEFAULT.md V3, std half). `tests/io/async_traits.test.yo` pinned `Dyn(Reader)` over a `File`, with `BufReader(Dyn(Reader))`. It now pins the refusal, and covers "BufReader wraps any Reader" through the generic parameter.

## What happens

The `Reader`/`Writer` defaults (`read_to_end`, `read_to_string`, `write_all` in `std/io/index.yo`) used to capture `self` by copy, which a `ref` `File` allowed. A move-only `File` cannot be copied into a future, so the defaults now borrow the reader: `io.async({ &self, io }(e : IoExn) => ...)`. `File.read` borrows its file too, because it advances the stored position after the read completes. A `Dyn`'s vtable future type carries no borrow, so §3.13 A2 rejects the erasure of any implementor, not only a `File`:

```
error[E0909]: `MemSource` cannot be made a `dyn(Reader)`: its method `Reader.read_to_end` returns a future that borrows `self` …
```

Nothing in `src/` or `std/` used `Dyn(Reader)`. The test above was its only user.

## Options

1. **Accept it.** Readers and writers are used concretely or through a generic `Impl(Reader)` parameter, which carries the borrow. `std/io/index.yo` and the DESIGN docs say so.
2. **A borrowed trait object for futures.** A `&Dyn(Reader)` whose vtable future type carries the borrow of the object (decision 44 already has the borrowed `&Dyn(Trait)` form for plain methods). The A2 rules would then apply to each call, not to the erasure, and a `Dyn(Reader)` inside a `ref` struct would be lent per call.
3. **Owning defaults for reference implementors.** Let a default capture `self` by copy when `Self` is a reference type and borrow it otherwise. That gives two future types for one trait method, which the vtable cannot express.

## Recommendation

Option 1 now, and option 2 as the follow-up when a user needs a heterogeneous reader or writer. Option 2 is Rust's shape (`&mut dyn AsyncRead`, polled through a borrow).
