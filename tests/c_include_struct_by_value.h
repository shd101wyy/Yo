/* Fixture for tests/c_include_struct_by_value.test.yo.
 *
 * A C struct that crosses the ABI BY VALUE in both directions — the shape
 * raylib, SDL and most C libraries are built around, and the one `c_include`
 * could not express until type adoption landed
 * (issues/fixed/c-include-cannot-express-a-by-value-c-struct.md).
 *
 * It lives beside the test on purpose: the test batch's generated .c is
 * emitted in this directory, so the quoted include resolves with no -I.
 */
#ifndef YO_TEST_C_INCLUDE_STRUCT_BY_VALUE_H
#define YO_TEST_C_INCLUDE_STRUCT_BY_VALUE_H

typedef struct YoTestPoint {
  double x;
  double y;
} YoTestPoint;

static inline YoTestPoint yo_test_point_make(double x, double y) {
  YoTestPoint p;
  p.x = x;
  p.y = y;
  return p;
}

static inline double yo_test_point_dot(YoTestPoint a, YoTestPoint b) {
  return (a.x * b.x) + (a.y * b.y);
}

static inline YoTestPoint yo_test_point_add(YoTestPoint a, YoTestPoint b) {
  YoTestPoint r;
  r.x = a.x + b.x;
  r.y = a.y + b.y;
  return r;
}

#endif /* YO_TEST_C_INCLUDE_STRUCT_BY_VALUE_H */
