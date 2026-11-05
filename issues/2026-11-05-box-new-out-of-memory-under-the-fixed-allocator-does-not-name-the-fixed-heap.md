# `Box.new` out of memory under `--allocator fixed` does not name the fixed heap

**Severity:** S3 — a missing diagnostic detail: a program that runs out of a fixed region through `Box.new` panics with `Box.new: out of memory`, without the request size and the fixed heap's size and occupancy that the runtime's allocation-failure message gives for an `Rc.new`.

Found while migrating `tests/cli-cases/compile-allocator-fixed-oom` off `ref(struct)` (V5 part B,
branch `vbd/v5-part-b-tests`), on develop 68b45b81d. The case chains nodes until a 64 KiB fixed
region is exhausted and pins the panic line. It was written for `ref` constructors, which
allocated through the emitted runtime's `__yo_rc_alloc`.

## Symptom

The same chain, one link per allocation, under `--allocator fixed` with `heap_size : usize(65536)`:

| Link | Panic line |
| --- | --- |
| `Rc.new(Node(…))` (`next : Option(Rc(Self))`) | `out of memory: requested 24 bytes (fixed heap 65536 bytes, live 57120 bytes in 1190 blocks)` |
| `Box.new(Node(…))` (`next : Option(Box(Self))`) | `Box.new: out of memory (at …/std/prelude.yo:10138:20)` |

The migrated case uses the `Rc` chain, which keeps its golden.

## Cause

`Rc.new` allocates through `__yo_rc_alloc`, whose failure path is the allocator's
`__yo_alloc_fail` (`src/codegen/c/allocator_fixed.yo`), and that path prints the region's
statistics. `Box.new` (`std/prelude.yo`, the `.None =>` arms around lines 10121 and 10138) calls
`__yo_malloc`/`__yo_aligned_alloc`, which return `None` on failure, and panics with its own fixed
string. Before V5 most user allocations were `ref` constructors and took the runtime path. After
V5, single-owner chains are `Box` chains.

## Fix direction

Route `Box.new`'s failure to the allocator's failure hook (the same `__yo_alloc_fail(size)` the
runtime uses), or have the fixed arm's `__yo_malloc` call the hook before it returns `None` for
infallible callers. Either way the panic names the region. `Box.try_new`-style fallible
allocation, if added, would keep returning `None`.

## Test

The fix adds a `Box` chain shape to `tests/cli-cases/compile-allocator-fixed-oom` (a second child
mode) whose kept line matches the same `^out of memory: requested [0-9]+ bytes \(fixed heap 65536
bytes` pattern, and moves this doc to `issues/fixed/`.
