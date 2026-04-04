# spawn and waitpid: str assigned to uint8_t\* pointer

## Status: Open (pre-existing)

## Description

The "spawn and waitpid" test in `tests/sys/process.test.yo` fails with a C
compilation error. A `Slice(u8)` (str) value is being assigned to a `uint8_t*`
pointer, which is a type mismatch in C.

## Error

```
error: assigning to 'uint8_t *' (aka 'unsigned char *') from incompatible type
'__yo_struct_yo1c2129e9_id_19544' (aka 'Slice_uint8_t')
  (*(argv + 0ULL)) = (__yo_struct_yo1c2129e9_id_19544){ .data = (uint8_t*)"echo", .length = 4 };
```

The codegen emits a `Slice(u8)` struct literal where a raw `uint8_t*` pointer is
expected by the target variable type.

## Affected Test

- `tests/sys/process.test.yo` — "spawn and waitpid"

## Notes

- Pre-existing bug, not caused by recent export linkage or index trait fixes.
- Reproduces on both the base branch and current working branch.
