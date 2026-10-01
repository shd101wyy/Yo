# Safe code reaches uninitialized and freed memory through `ArrayList.set_len`

**Severity:** S1 — a file WITHOUT `Pragma.AllowUnsafe` reads uninitialized slots and use-after-freed RC elements; under Guard Malloc with the system allocator the program segfaults (rc=139).

- **Status:** FIXED 2026-10-01 (`fix/arraylist-init-token`). `set_len` is
  deleted; growth over unwritten memory needs the spare-capacity token, and safe
  code cannot hold it. `markdown_yo` v0.0.9, the compiler's own dependency,
  dropped its `set_len` calls (it now uses `extend_from_ptr` and `truncate`), so
  this did not need a seed carrying the token API after all. The dependency is
  bumped to `^0.0.9`.

- **Found:** 2026-09-30 by the ATS audit (`plans/ATS_LESSONS_BEYOND_INDEXED_TYPES.md`
  §3, ATS's `T?` uninitialized-type row).
- **Component:** `std/collections/array_list.yo` — `set_len` (public, no
  pointer in its type, so the safe-mode gate never sees it).

## Reproducer (measured: seed `yo 0.2.46`, macOS arm64)

```rust
// A SAFE file: no pragma(Pragma.AllowUnsafe).
{ ArrayList } :: import("std/collections/array_list");
{ println } :: import("std/fmt");
{ String } :: import("std/string");
main :: (fn() -> unit)({
  xs := ArrayList(i64).new();
  xs.push(i64(11));
  xs.push(i64(22));
  _ := xs.pop();
  _ := xs.pop();
  xs.set_len(usize(2));
  println(`stale ints: ${xs(usize(0)).to_string()} ${xs(usize(1)).to_string()}`);
  names := ArrayList(String).new();
  names.push(String.from("hello, dangling world"));
  _ := names.pop();
  names.set_len(usize(1));
  s := names(usize(0));
  println(`dangling string len = ${s.len().to_string()}`);
});
export(main);
```

- `yo check`: rc=0 (accepted as safe code).
- `yo compile --optimize 2` and run: prints `stale ints: 11 22` and
  `dangling string len = 21`. It reads elements the list no longer owns.
- `--allocator system` under `DYLD_INSERT_LIBRARIES=/usr/lib/libgmalloc.dylib`:
  **rc=139** (SIGSEGV).
- `ArrayList(i64).with_capacity(8)` then `set_len(8)` reads eight
  never-written slots. They were zero in this run only because the
  allocation was fresh.

## Root cause

Yo's safe-mode gate is by TYPE: anything that carries a raw pointer is
unavailable without `Pragma.AllowUnsafe` (`plans/reference/MEMORY_SAFETY.md`).
`ptr()` and `extend_from_ptr` are gated that way. `set_len(self, new_len :
usize)` mentions no pointer, so it is callable from safe code. Its doc
comment already calls it "just as unsafe" as Rust's `Vec::set_len`. Its
`requires(new_len <= self.capacity())` bounds the length but says nothing
about which slots are initialized.

Its only std caller is `std/io/index.yo:91` (a read into the spare capacity
through `ptr()`, then `set_len(len + n)`), which already holds a raw pointer.

## Recommendation (as filed)

Make growth need a proof token that safe code cannot hold. This is ATS's
answer: to claim a region initialized, you present its view.

- `spare_capacity(self) -> RawSlice(T)`: the uninitialized tail,
  pointer-carrying and so unsafe-only.
- `assume_init(self, n : usize, spare : RawSlice(T), requires(n <= spare.len()))`
  commits the first `n` slots of that spare region.
- `set_len` becomes shrink-only and drops the elements past the new end
  (that is `truncate`, so remove `set_len` and point callers at
  `truncate`).
- `std/io/index.yo` switches to `spare_capacity` + `assume_init`.

The gate stays purely type-based, and no per-function `unsafe fn` marker
(rejected in `MEMORY_SAFETY.md`) is needed. A regression test: a safe file
calling the grow form must fail `check` (a `comptime_expect_error` in
`tests/`), and the repro above must no longer compile.

## Fix (as landed, and where it differs from the recommendation)

The first cut followed the recommendation literally:
`spare_capacity() -> Option(RawSlice(T))`. **It did not close the hole.**

Measured with the stack binary: a SAFE file compiled
`match(xs.spare_capacity(), .Some(s) => xs.assume_init(usize(2), s), .None => ())`
with rc=0, and the program then read the uninitialized slot. The safe-mode VALUE
gate (`_surfaces_raw_pointer`, `src/evaluator/exprs/_expr.yo`) fires on a
`*(T)` and on an enum whose payload IS a `*(T)`. A struct that only CONTAINS one
is not caught: safe code may hold `String.raw_bytes() -> RawSlice(u8)` today
(measured: `check` rc=0). The type-based gate that does look inside structs,
`type_representation_contains_raw_ptr`, guards parameter ANNOTATIONS only, and
a call never names the type. The Gen A cli-case that was meant to pin this never
had a recorded golden. Its keep-match matched nothing, so the harness reported it
as vacuous instead of failing.

What landed is the shape `ptr()` already uses:

- `spare_capacity(self) -> Option(*(T))`: a pointer to the first uninitialized
  slot, `ptr() + len()`. The spare count is `capacity() - len()`.
- `assume_init(self, n, spare : *(T), requires(n <= (self.capacity() - self.len())))`
  panics unless `spare` is this list's current end.
- `set_len` is removed. `truncate` is the safe shrink, and it drops the
  elements past the new end.
- `std/io/index.yo`'s `read_to_end` reads into `spare` for
  `capacity() - len()` bytes.

The value gate rejects the token in every safe shape (measured):

| Shape | Result |
| --- | --- |
| `s := xs.spare_capacity();` | rc=1 |
| `_ := xs.spare_capacity();` | rc=1 |
| `match(xs.spare_capacity(), ...)` | rc=1 |

Each is reported as ``Raw pointer values are not available in safe code: '(xs.spare_capacity)()' has type '?(*(T))'``. The reproducer above now fails `check` with E0610
(`No method "set_len"`).

## Regression tests

- `tests/cli-cases/spare-capacity-safe-code`: the discarded form in a safe file
  must report the value gate's diagnostic. Its keep-match now names that
  message.
- `tests/collections/array_list.test.yo`: the unsafe-capable round trip. It
  writes through `spare`, commits with `assume_init`, and checks that the length
  and the committed slot are right with no reallocation.
