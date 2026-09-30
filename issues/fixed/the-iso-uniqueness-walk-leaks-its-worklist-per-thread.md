# The Iso uniqueness walk leaks its worklist once per thread

**Severity:** S3 — a bounded leak (one worklist per thread that ever ran `^`); LeakSanitizer reports it in every program that isolates a value, and it hid other leaks in those suites
**Found:** 2026-09-30, running the RC and Iso suites locally (the default ASan and LSan run) for `plans/archive/EXPLICIT_ALLOCATORS.md` P2. `develop` at `f7f1331fb` fails the same six tests.

## Reproducer

```rust
{ println } :: import("std/fmt");
main :: (fn() -> unit)({
  x := Box(i32)(42);
  match(
    ^x,
    .Some(iso) => {
      e := iso.extract();
      println(e.*);
    },
    .None => println("none")
  );
});
export(main);
```

```
yo compile iso.yo --sanitize address --allocator system -o iso && ./iso
==ERROR: LeakSanitizer: detected memory leaks
Direct leak of 1024 byte(s) in 1 object(s) allocated from:
    #0 realloc
    #1 __yo_iso_uq_visit
    #2 __yo_iso_uq_run
    #3 __yo_iso_unique_Iso___yo_t_…
```

In the suites, these tests fail with "Memory leak detected":

- `tests/rc.test.yo`: "Test Rc with Iso".
- `tests/iso.test.yo`: four tests.
- `tests/iso_api_surface.test.yo`: "Iso extract returns T directly (no Option)".

## Cause

`^v` proves the value's reference graph unique with an explicit worklist
(`generate_iso_uniqueness_functions`, `src/codegen/functions/constructors.yo`).
The worklist was a thread-local heap buffer that grew on demand and was kept
for the next walk, and nothing ever freed it. When the thread exits, its
thread-locals stop being roots, so the buffer is unreachable and LSan reports
it. Every program's `main` runs on a worker thread, so even a single-threaded
program leaks one buffer.

## Fix

`__yo_iso_uq_run` points the worklist at a 64-item buffer on its own stack.
The visitor moves the worklist to the heap only when a walk outgrows that buffer,
and the run frees the heap copy before it returns. A typical `^` now makes no
allocation, and no walk leaves memory behind. The regression tests are the
six suite tests above, which fail before the fix and pass after it.
