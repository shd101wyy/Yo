/* Exhaustive check of scripts/musl-fastmem.c against byte-loop references: every n <= 300 at 40x40
 * source/destination offsets, overlapping both ways for memmove, disjoint for memcpy, and memcmp with
 * one differing byte at every position. Link it with the fastmem object (the release and CI musl
 * steps do) so the calls below resolve to those definitions, not libc's. Compile with -fno-builtin
 * so the compiler emits real calls instead of open-coding them. Exit 0 = all agree. */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static unsigned char buf[1024], ref[1024], orig[1024], tmp[400];

static int sgn(int x) { return (x > 0) - (x < 0); }

int main(void) {
  long checks = 0;
  srand(1);
  for (int i = 0; i < 1024; i++) orig[i] = (unsigned char)rand();
  for (size_t n = 0; n <= 300; n++) {
    for (int so = 0; so < 40; so++) {
      for (int dof = 0; dof < 40; dof++) {
        /* memmove inside one buffer: source and destination overlap whenever |so - dof| < n. */
        for (int i = 0; i < 1024; i++) buf[i] = ref[i] = orig[i];
        for (size_t i = 0; i < n; i++) tmp[i] = ref[280 + so + i];
        for (size_t i = 0; i < n; i++) ref[280 + dof + i] = tmp[i];
        if (memmove(buf + 280 + dof, buf + 280 + so, n) != buf + 280 + dof) {
          printf("memmove returned the wrong pointer (n=%zu)\n", n);
          return 1;
        }
        for (int i = 0; i < 1024; i++)
          if (buf[i] != ref[i]) {
            printf("memmove n=%zu src+%d dst+%d differs at %d\n", n, so, dof, i);
            return 1;
          }
        /* memcpy between disjoint ranges. */
        for (int i = 0; i < 1024; i++) buf[i] = ref[i] = orig[i];
        for (size_t i = 0; i < n; i++) ref[600 + dof + i] = ref[so + i];
        if (memcpy(buf + 600 + dof, buf + so, n) != buf + 600 + dof) {
          printf("memcpy returned the wrong pointer (n=%zu)\n", n);
          return 1;
        }
        for (int i = 0; i < 1024; i++)
          if (buf[i] != ref[i]) {
            printf("memcpy n=%zu src+%d dst+%d differs at %d\n", n, so, dof, i);
            return 1;
          }
        checks += 2;
      }
      /* memcmp: equal ranges, then one differing byte at each position k. */
      for (size_t k = 0; k <= n; k++) {
        unsigned char *a = buf + so, *b = buf + 500 + so;
        for (int i = 0; i < 1024; i++) buf[i] = orig[i];
        for (size_t i = 0; i < n; i++) b[i] = a[i];
        if (k < n) b[k] = (unsigned char)(b[k] + 1 + rand() % 254);
        int want = 0;
        for (size_t i = 0; i < n; i++)
          if (a[i] != b[i]) {
            want = a[i] - b[i];
            break;
          }
        if (sgn(memcmp(a, b, n)) != sgn(want)) {
          printf("memcmp n=%zu offset %d mismatch at %zu\n", n, so, k);
          return 1;
        }
        checks++;
      }
    }
  }
  printf("musl-fastmem: %ld checks agree\n", checks);
  return 0;
}
