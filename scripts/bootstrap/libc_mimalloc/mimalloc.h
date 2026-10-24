/* A stand-in <mimalloc.h> that maps the six mi_* entry points the emitted C
 * uses onto the C library's allocator. For ONE use: the evaluator work ratchet
 * (scripts/bootstrap/eval_work_ratchet.sh, the memory-ratchet job in
 * .github/workflows/test.yml) recompiles CI's mimalloc-flavored stage-2 C on
 * the C library's malloc, so an LD_PRELOAD counter sees every allocation:
 *
 *   clang ... -I scripts/bootstrap/libc_mimalloc /tmp/stage2/yo-stage2.c ...
 *
 * The emitted C has no silent fallback (a missing <mimalloc.h> is an #error,
 * issues/retired/explicit-allocator-mimalloc-falls-back-to-malloc-when-vendor-is-missing.md),
 * so asking for the C library's heap is this explicit include path. */
#ifndef YO_LIBC_MIMALLOC_SHIM_H
#define YO_LIBC_MIMALLOC_SHIM_H
#include <stdlib.h>
#define mi_malloc malloc
#define mi_calloc calloc
#define mi_realloc realloc
#define mi_free free
#define mi_aligned_alloc aligned_alloc
#endif
