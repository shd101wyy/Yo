// alloc_count.c — an LD_PRELOAD allocation counter for the evaluator work
// ratchet (scripts/bootstrap/eval_work_ratchet.sh). Linux/glibc only.
//
//   cc -O2 -shared -fPIC -o /tmp/alloc_count.so scripts/bootstrap/alloc_count.c
//   YO_ALLOC_COUNT_OUT=/tmp/counts LD_PRELOAD=/tmp/alloc_count.so <program>
//
// Counts malloc / calloc / realloc / aligned_alloc / posix_memalign /
// memalign calls and free calls, plus the bytes requested, and at exit
// APPENDS one line per process to $YO_ALLOC_COUNT_OUT:
//
//   pid=<pid> malloc=<n> calloc=<n> realloc=<n> aligned=<n> free=<n> bytes=<n>
//
// Children inherit LD_PRELOAD, so every process appends its own line; the
// script sums them. The program must link malloc DYNAMICALLY: a binary built
// with `--allocator mimalloc` and the vendored static.c calls mi_malloc
// directly and this shim sees none of it.
//
// Forwards to glibc's exported __libc_* entry points rather than
// dlsym(RTLD_NEXT): dlsym itself allocates and would recurse into calloc.
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>

extern void *__libc_malloc(size_t);
extern void *__libc_calloc(size_t, size_t);
extern void *__libc_realloc(void *, size_t);
extern void *__libc_memalign(size_t, size_t);
extern void __libc_free(void *);

static uint64_t n_malloc, n_calloc, n_realloc, n_aligned, n_free, n_bytes;

#define BUMP(c) __atomic_fetch_add(&(c), 1, __ATOMIC_RELAXED)
#define ADD(c, v) __atomic_fetch_add(&(c), (uint64_t)(v), __ATOMIC_RELAXED)

void *malloc(size_t size) {
  BUMP(n_malloc);
  ADD(n_bytes, size);
  return __libc_malloc(size);
}

void *calloc(size_t nmemb, size_t size) {
  BUMP(n_calloc);
  ADD(n_bytes, nmemb * size);
  return __libc_calloc(nmemb, size);
}

void *realloc(void *ptr, size_t size) {
  BUMP(n_realloc);
  ADD(n_bytes, size);
  return __libc_realloc(ptr, size);
}

void free(void *ptr) {
  if (ptr) BUMP(n_free);
  __libc_free(ptr);
}

void *aligned_alloc(size_t alignment, size_t size) {
  BUMP(n_aligned);
  ADD(n_bytes, size);
  return __libc_memalign(alignment, size);
}

void *memalign(size_t alignment, size_t size) {
  BUMP(n_aligned);
  ADD(n_bytes, size);
  return __libc_memalign(alignment, size);
}

int posix_memalign(void **out, size_t alignment, size_t size) {
  BUMP(n_aligned);
  ADD(n_bytes, size);
  void *p = __libc_memalign(alignment, size);
  if (!p) return ENOMEM;
  *out = p;
  return 0;
}

#define LOAD(c) __atomic_load_n(&(c), __ATOMIC_RELAXED)

__attribute__((destructor)) static void alloc_count_report(void) {
  const char *path = getenv("YO_ALLOC_COUNT_OUT");
  if (!path || !*path) return;
  char line[256];
  int len = snprintf(line, sizeof line,
                     "pid=%ld malloc=%llu calloc=%llu realloc=%llu aligned=%llu free=%llu bytes=%llu\n",
                     (long)getpid(), (unsigned long long)LOAD(n_malloc),
                     (unsigned long long)LOAD(n_calloc), (unsigned long long)LOAD(n_realloc),
                     (unsigned long long)LOAD(n_aligned), (unsigned long long)LOAD(n_free),
                     (unsigned long long)LOAD(n_bytes));
  if (len <= 0) return;
  int fd = open(path, O_WRONLY | O_CREAT | O_APPEND, 0644);
  if (fd < 0) return;
  ssize_t w = write(fd, line, (size_t)len);
  (void)w;
  close(fd);
}
