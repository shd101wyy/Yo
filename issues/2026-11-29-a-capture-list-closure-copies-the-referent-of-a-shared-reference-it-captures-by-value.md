# A capture-list closure that captures a shared reference by value gets a writable shallow copy of the referent

**Severity:** S1 — memory unsafety from safe code: `{ xs }` with `xs : &ArrayList(i32)` gives the closure a shallow copy of the list header that shares the caller's buffer, and `yo check` treats that copy as writable. An element write lands in the caller's list through a `&`; a growing write frees the buffer the caller still reads (heap-use-after-free under ASan). No `AllowUnsafe`, no `unsafe`.

- Filed: 2026-11-29. Found 2026-11-28 while auditing `plans/backlog/GENERATORS.md` (GitHub #2145, finding 3): a `gen` body is a capture-list closure, G7 assumes the capture rules, and §1's `flatten` captures a reference parameter this way.
- Status: open.
- Reproduces on the v0.2.80 seed (bundled std, and with a tree's std through `--std-path`) and on a stage 1 of develop `2381b8784`, built from the tree and run with its own std.
- No duplicate. The nearest record is `issues/fixed/2026-11-08-a-shared-capture-is-typed-as-a-mut-reference-inside-the-closure-body.md`: a BORROW capture (`{ rx : &x }`) typed `&mut` in the body, fixed by recording the capture's written mode; its doc notes a write through it was still rejected. This one is a BY-VALUE capture of a reference-typed variable, which is neither a borrow capture nor marked. `issues/2026-11-14-the-inout-borrow-audit-labels-a-by-value-capture-list-entry-a-match-or-for-binding.md` is the audit-mode noun for the same binding kind, and its open question ("whether a decision-47 own copy should be listed at all") is where that binding's own-copy status is discussed.

## Reproducer

Three files. Each has a function taking `xs : &ArrayList(i32)` and a local closure whose capture list is `{ xs }`; none is `AllowUnsafe`.

- `issues/repros/2026-11-29-a-capture-list-closure-copies-the-referent-of-a-shared-reference-it-captures-by-value-for-write.yo`: the closure runs `for(xs, x => { x.* = i32(99); });`. Expected: E0908, which is what the same loop gets in a plain function body.
- `issues/repros/2026-11-29-a-capture-list-closure-copies-the-referent-of-a-shared-reference-it-captures-by-value-header-copy.yo`: the closure binds `(m : &mut ArrayList(i32)) = &mut xs.*;` and pushes into a list that has spare capacity. Expected: E0908, `Cannot borrow … with &mut: … is a & borrow`.
- `issues/repros/2026-11-29-a-capture-list-closure-copies-the-referent-of-a-shared-reference-it-captures-by-value-use-after-free.yo`: the same on a list with no spare capacity, so the push reallocates. Expected: E0908.

## Output

The seed and the stage 1 give the same results. `yo check` reports `evaluator OK` for all three.

- **`for-write`**, compiled with `--optimize 2` and run: `99`, `99`, `99`. The caller's list, lent as `&`, is rewritten.
- **`header-copy`**, run: `len seen by main: 3`, then `1`, `5`, `2`. The closure's push did not reach the caller's header, so the closure's `xs` is not the caller's list: it is a second header over the same buffer.
- **`use-after-free`**, run at `--optimize 2`: no output, rc 133 (SIGTRAP). Built with `--sanitize address --allocator system`:

```text
==29729==ERROR: AddressSanitizer: heap-use-after-free on address 0x602000001010 at pc 0x0001045d946c bp 0x000340006db0 sp 0x000340006da8
READ of size 4 at 0x602000001010 thread T1
    #0 0x0001045d9468 in __yo_user_main+0xaf8 (p3-asan:arm64+0x100001468)
    #1 0x0001045d98e4 in __yo_main_thread_entry+0x64 (p3-asan:arm64+0x100000e8e4)

0x602000001010 is located 0 bytes inside of 12-byte region [0x602000001010,0x60200000101c)
freed by thread T1 here:
    #0 0x000104570350 in realloc+0x80 (libclang_rt.asan_osx_dynamic.dylib:arm64e+0x41350)
    #1 0x0001045d4ae4 in __yo_user_main+0x174 (p3-asan:arm64+0x100000ae4)
```

The stage 1's report, its frame lines kept and the rest of each stack dropped. The push through the copy reallocated (12 bytes is three `i32`), the old buffer was freed, and `main` then read it through its own header.

**Controls**, each rejected with E0908 on both compilers:

| Spelling | Result |
| --- | --- |
| the same `for(xs, x => …)` loop in a plain function body over the `&ArrayList(i32)` parameter | `Cannot assign to `x`: `x` is a `&` borrow, which is read-only.` |
| `mut(r) := xs;` then `&mut r.*` in a plain function | `Cannot borrow `r` with `&mut`: `r` is a `&` borrow` |
| `v := xs;` then `v.push(…)` in a plain function | E0908; `v` is bound as a read-only reference |
| a closure with an IMPLICIT capture, same loop | `Cannot assign to `x`: `x` is a `&` borrow` |
| the capture-list closure with `for(&xs.*, x => …)`, same write | `Cannot assign to `x`: `x` is a `&` borrow` |
| the capture-list closure calling `xs.push(…)` directly, as `Fn` and as `FnMut` | `Cannot pass `xs` as the `self : &mut Self` receiver` |

## Root cause (first pass)

What the probes establish:

1. **The body's binding is writable where nothing else is.** In the capture-list closure `xs.into_iter()` resolves to `ArrayListCursorMut(T, origin(p))`; at function level, on the same `&ArrayList(i32)`, it resolves to `ArrayListCursor(T, origin(p))`. `&mut xs.*` on the capture passes too.
2. **The body's binding is not the caller's list.** `header-copy` shows a header the caller cannot see over a buffer the caller can: a bitwise copy of the struct, not a `clone()`.
3. **The copy is made by the capture list.** `v := xs;` in a plain function is a reference binding, read-only (control above). The implicit capture gives the shared cursor.

The reading I draw from it, not yet confirmed in the source: a capture-list entry `{ xs }` evaluates `xs` as a value and stores what a read of a reference yields, the referent, as a plain copy; the body then binds `xs` as a reference to that copy. Because the entry is an own copy (decision 47), the place behind it is writable, and nothing records that the thing copied sat behind a shared reference.

Why the E0908 gates miss it: the receiver gate that stops `xs.push(…)` on the same capture is `_borrowed_root_walk`'s arm in `src/evaluator/exprs/assignment.yo` (`:976`–`:997`, the noun "a `match` or `for` binding"), and the `&T` parameter root is `shared_borrow_param_root_of_place` (`:950`). Both run for a `self : &mut Self` receiver. Neither runs when a `&mut` VALUE is derived from the place: the explicit `&mut xs.*`, and the implicit one the evaluator builds for a generic impl whose method takes `self : Self` with `Self = &mut C` (`impl(&mut C, IntoIterator)`), which is how the cursor becomes `ArrayListCursorMut`.

Where to start: the capture binding in `src/evaluator/values/anonymous_function.yo`, where the 2026-11-08 fix above made a borrow capture record its written mode (`variable_set_reference_mut(&cv, ce.is_mut)`). A by-value entry whose source is a reference needs the same two facts: that it holds a reference, and that the reference is shared. Until it has them, a `gen` body's `{ xs }` capture of a reference parameter, the shape of `GENERATORS.md` §1's `flatten`, is not what that plan's G7 assumes.

## Test

The test lands with the fix, in `tests/closure_capture_list.test.yo`, where the 2026-11-08 fix pinned a capture's mode: the three reproducers as cases that expect E0908, and the six controls above, which must keep their E0908.
