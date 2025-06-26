#include <stdint.h>
#include <stdio.h>

int32_t add(int32_t a, int32_t b) {
    return a + b;
}

int int_add(int a, int b) {
    return a + b;
}

int factorial(int n, int acc) {
    if (n <= 1) {
        return acc;
    }
    return factorial(n - 1, n * acc);
}

int factorial_recursive(int n) {
    if (n <= 1) {
        return 1;
    }
    return n * factorial_recursive(n - 1);
}

int main() {
    int32_t x = add(3, sizeof(int32_t));
    int y = int_add(5, sizeof(int));
    int z = factorial(5, 1);
    int r = factorial_recursive(5);

    printf("x: %d, y: %d\n", x, y);
    printf("Factorial (iterative): %d\n", z);
    printf("Factorial (recursive): %d\n", r);

    return 0;
}