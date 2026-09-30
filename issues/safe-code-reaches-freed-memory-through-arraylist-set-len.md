# Safe code reaches uninitialized and freed memory through `ArrayList.set_len`

**Severity:** S1 — a file WITHOUT `Pragma.AllowUnsafe` reads uninitialized slots and use-after-freed RC elements; under Guard Malloc with the system allocator the program segfaults (rc=139).

- **Found:** 2026-09-30 by the ATS audit (`plans/backlog/ATS_LESSONS_BEYOND_INDEXED_TYPES.md`
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

## Recommendation

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
