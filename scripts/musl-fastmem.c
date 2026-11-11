/* memcpy / memmove / memcmp for the static musl bundle (release.yml musl-bundle, test.yml's musl leg).
 *
 * musl's own x86_64 memcpy is a `rep movsq` loop (slow start-up on short copies) and its memmove /
 * memcmp are generic byte-at-a-time C; the compiler binary spends ~10% of its time in memcpy alone on
 * them (issues/fixed/2026-11-11-the-static-musl-bundle-runs-1-6x-slower-than-a-glibc-build.md). This
 * file is linked AHEAD of libc.a, so the static link takes these definitions and never pulls musl's
 * memcpy.o / memmove.o / memcmp.o.
 *
 * Portable C, no ISA beyond the baseline: the 16-byte vector type lowers to SSE2 on x86_64 and NEON
 * on aarch64, both part of the base ABI, so the binary still runs on any x86-64 / aarch64.
 *
 * x86_64 only: on aarch64 musl already ships an assembly memcpy, and the recipe keeps it
 * (VERDICTS-56).
 *
 * MUST be compiled on its own with `-fno-builtin` (the release steps assert `nm -u` lists no mem*
 * symbol): without it the compiler may turn the copy loops below back into calls to memcpy itself.
 */
#include <stddef.h>
#include <stdint.h>

typedef unsigned char v16 __attribute__((vector_size(16), aligned(1), may_alias));
typedef uint64_t u64u __attribute__((aligned(1), may_alias));
typedef uint32_t u32u __attribute__((aligned(1), may_alias));
typedef uint16_t u16u __attribute__((aligned(1), may_alias));

#define LD16(p) (*(const v16 *)(p))
#define ST16(p, v) (*(v16 *)(p) = (v))

/* n <= 64 bytes. Every load happens before every store, so this is overlap-safe in both directions. */
static inline __attribute__((always_inline)) void copy_small(unsigned char *d, const unsigned char *s, size_t n) {
  if (n >= 32) {
    v16 a = LD16(s), b = LD16(s + 16), c = LD16(s + n - 32), e = LD16(s + n - 16);
    ST16(d, a); ST16(d + 16, b); ST16(d + n - 32, c); ST16(d + n - 16, e);
  } else if (n >= 16) {
    v16 a = LD16(s), b = LD16(s + n - 16);
    ST16(d, a); ST16(d + n - 16, b);
  } else if (n >= 8) {
    uint64_t a = *(const u64u *)s, b = *(const u64u *)(s + n - 8);
    *(u64u *)d = a; *(u64u *)(d + n - 8) = b;
  } else if (n >= 4) {
    uint32_t a = *(const u32u *)s, b = *(const u32u *)(s + n - 4);
    *(u32u *)d = a; *(u32u *)(d + n - 4) = b;
  } else if (n >= 2) {
    uint16_t a = *(const u16u *)s, b = *(const u16u *)(s + n - 2);
    *(u16u *)d = a; *(u16u *)(d + n - 2) = b;
  } else if (n == 1) {
    *d = *s;
  }
}

/* n > 64, forward. Safe when d <= s or the ranges are disjoint: the tail is loaded before any store. */
static void copy_fwd(unsigned char *d, const unsigned char *s, size_t n) {
  v16 tail = LD16(s + n - 16);
  unsigned char *dend = d + n - 16;
  while (n > 16) {
    v16 a = LD16(s);
    ST16(d, a);
    d += 16; s += 16; n -= 16;
  }
  ST16(dend, tail);
}

/* n > 64, backward. Safe when d >= s: the head is loaded before any store. */
static void copy_bwd(unsigned char *d, const unsigned char *s, size_t n) {
  v16 head = LD16(s);
  unsigned char *d0 = d;
  while (n > 16) {
    n -= 16;
    v16 a = LD16(s + n);
    ST16(d + n, a);
  }
  ST16(d0, head);
}

void *memmove(void *dst, const void *src, size_t n) {
  unsigned char *d = dst;
  const unsigned char *s = src;
  if (n <= 64) copy_small(d, s, n);
  else if ((uintptr_t)d - (uintptr_t)s >= n) copy_fwd(d, s, n);
  else copy_bwd(d, s, n);
  return dst;
}

/* memcpy has memmove semantics on purpose. Overlapping memcpy is undefined behavior, but until this
 * file existed Alpine's fortify-headers turned it into a trap, so an overlapping call in the compiler
 * could not have gone unnoticed; with fortify off (the musl recipe builds with -U_FORTIFY_SOURCE) a
 * silent wrong copy would be the worse outcome. The direction test costs one compare. */
void *memcpy(void *restrict dst, const void *restrict src, size_t n) {
  return memmove(dst, src, n);
}

int memcmp(const void *vl, const void *vr, size_t n) {
  const unsigned char *l = vl, *r = vr;
  while (n >= 8) {
    uint64_t a = *(const u64u *)l, b = *(const u64u *)r;
    if (a != b) {
#if __BYTE_ORDER__ == __ORDER_LITTLE_ENDIAN__
      a = __builtin_bswap64(a);
      b = __builtin_bswap64(b);
#endif
      return a < b ? -1 : 1;
    }
    l += 8; r += 8; n -= 8;
  }
  for (; n && *l == *r; n--, l++, r++);
  return n ? *l - *r : 0;
}
