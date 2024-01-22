#include <stdbool.h>
#include <stdint.h>
#include <stddef.h>
struct Unit {};
struct Unit unit = {};

int id1(
  struct {int x; int y;} point
) {
  return 0;
}

struct {int x; int y;} id2(
) {
  struct {
    int x;
    int y;
  } point = { .x = 1, .y = 2 };
  return point;
}

int main() {
  // Anonymous struct
  struct {
    int x;
    int y;
  } point = { .x = 1, .y = 2 };

  id(point);
}