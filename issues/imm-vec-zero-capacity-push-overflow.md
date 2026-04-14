# `imm.Vec` zero-capacity push overflow

## Problem

`Vec(T)` could produce empty vectors with `_cap == 0` through `with_capacity(0)` and
through methods like `concat`/`map`/`zip_with` on empty inputs. `push()` only grew
when `_cap > 0`, so pushing into one of these vectors kept `new_cap == 0`.

That led to a zero-sized allocation followed by writing the pushed element into the
buffer, which AddressSanitizer reports as a heap-buffer-overflow.

## Fix

1. Make `_raw_alloc(0)` allocate space for at least one element, avoiding zero-sized
   allocations.
2. Teach `push()` to grow zero-capacity vectors to the normal minimum growth size.

## Regression coverage

- `Vec with_capacity zero then push`
- `Vec concat two empties then push`
