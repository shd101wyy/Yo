#include <stdint.h>

int32_t add(int32_t a, int32_t b) {
    return a + b;
}

int int_add(int a, int b) {
    return a + b;
}

int main() {
    int32_t x = add(3, sizeof(int32_t));
    int y = int_add(5, sizeof(int));

    short x = 12;
    unsigned short y = x;

    return 0;
}