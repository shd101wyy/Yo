/* Fixture for tests/c_include_const_result.test.yo.
 *
 * C functions whose result is a `const` pointer, as raylib's `TextFormat`
 * and libc's `gai_strerror` are. Yo has no const pointer, so the binding
 * spells the result `*(char)` / `*(u8)`, and the generated C reads it as that
 * type (issues/fixed/2026-11-05-a-c-include-function-returning-a-const-pointer-fails-the-clang-build.md).
 *
 * Dropping the `const` is a hard error under clang (the driver's
 * `-Werror=incompatible-pointer-types`) and only a warning under gcc, so the
 * pragmas below make it an error under both: the test fails on every C
 * compiler while a result loses its qualifier.
 */
#ifndef YO_TEST_C_INCLUDE_CONST_RESULT_H
#define YO_TEST_C_INCLUDE_CONST_RESULT_H

#include <stddef.h>
#include <string.h>

#if defined(__clang__)
#pragma clang diagnostic error "-Wincompatible-pointer-types-discards-qualifiers"
#elif defined(__GNUC__)
#pragma GCC diagnostic error "-Wdiscarded-qualifiers"
#endif

static inline const char* yo_test_const_name(int which) {
  return which == 0 ? "zero" : "const result";
}

static inline const unsigned char* yo_test_const_bytes(void) {
  return (const unsigned char*)"ab";
}

static inline size_t yo_test_const_len(const char* s) {
  return strlen(s);
}

static inline const char* yo_test_const_maybe(int which) {
  return which == 0 ? (const char*)0 : "maybe";
}

static inline int yo_test_const_first(const unsigned char* b) {
  return (int)b[0];
}

#endif
