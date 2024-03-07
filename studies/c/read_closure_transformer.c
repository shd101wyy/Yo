#include <stdio.h>

typedef struct ReadClosure
{
    int *x;
} ReadClosure;

int call(ReadClosure closure, int y)
{
    return *(closure.x) + y;
}

int test(ReadClosure closure, int y) {
    return call(closure, y);
}

int main() {
    int x = 1;
    int result = test((ReadClosure){&x}, 2);
    printf("%d\n", result);
}