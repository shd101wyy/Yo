#include <stdio.h>

typedef struct WriteClosure
{
    int *x;
} WriteClosure;

void call(WriteClosure closure, int y)
{
    *(closure.x) += y;
}

void test(WriteClosure closure, int y) {
    call(closure, y);
}

int main() {
    int x = 1;
    test((WriteClosure){&x}, 2);
    printf("%d\n", x);
}