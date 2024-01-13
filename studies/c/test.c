#include <stdio.h>

struct Test {
  int x;
};

void increment(struct Test *t) {
  t->x++;
}

int main() {
  struct Test t;
  t.x = 0;
  increment(&t);
  printf("%d\n", t.x);
  return 0;
}