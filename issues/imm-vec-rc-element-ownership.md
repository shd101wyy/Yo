`std/imm/vec.yo` was copying and disposing elements as raw bytes.

## Problems

- `Dispose` freed the backing buffer without dropping stored elements first.
- `push`, `set`, `pop`, `slice`, `concat`, and `from_slice` copied elements through raw memory operations.
- For `Send` element types that still contain RC-managed fields, this bypassed the required dup/drop behavior.

## Symptoms

- Crashes when copying RC-backed elements into freshly allocated buffers.
- Leaks when vectors containing RC-backed elements are dropped.

## Fix

- Added element-wise copy through `consume(...)` for writes into uninitialized slots.
- Taught `Dispose` to `unsafe.drop(...)` each stored element before freeing the buffer.
- Added a regression in `tests/imm_vec.test.yo` that stores `imm.String` inside a `Vec` element struct.
