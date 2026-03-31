# mimalloc 3.3x slower than libc malloc for allocation-heavy workloads

## Status: RESOLVED (default allocator changed to libc)

## Summary

For workloads with many small RC object allocations and frees (e.g., markdown parser creating ~100K Token objects per MB, each with 4 String fields wrapping ArrayList RC objects), mimalloc is approximately 3.3x slower than the system libc allocator on macOS (Apple Silicon).

## Benchmark (markdown_it_yo, 5MB input)

| Allocator | User Time | RSS   |
| --------- | --------- | ----- |
| libc      | 0.49s     | 829MB |
| mimalloc  | 1.61s     | 869MB |

## Profile Analysis

With mimalloc, 69% of CPU time is spent in allocator functions:

- `mi_arenas_page_alloc_fresh`: 19%
- `_mi_theap_page_reclaim`: 14%
- `_mi_theap_malloc_zero`: 13%
- `mi_free_block_local`: 6%
- `mi_validate_ptr_page`: 5%
- Other mimalloc functions: 12%

With libc, allocator takes ~50% but the absolute time is 3.3x less.

## Hypothesis

mimalloc's arena-based allocation and page reclamation overhead doesn't suit the pattern of many small (~40 byte) allocations with short lifetimes (RC objects created and freed rapidly). The arena page management (`mi_arenas_page_alloc_fresh`, `_mi_theap_page_reclaim`) dominates.

## Environment

- macOS 15, Apple Silicon (M-series)
- mimalloc bundled with Yo (vendored in `vendor/mimalloc/`)
- clang -O3

## Recommendation

Consider:

1. Making libc the default allocator (or at least for macOS)
2. Investigating mimalloc configuration options (arena sizes, page sizes)
3. Profiling mimalloc on Linux to see if the issue is macOS-specific
4. Reducing allocation count in generated code (small buffer optimization, arena allocators)
