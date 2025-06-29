#include <stdint.h>
#include <stdbool.h>

// Implementation of the extern add function
int32_t add(int32_t x, int32_t y) {
    return x + y;
}

// Implementation of the extern sub function
int32_t sub(int32_t x, int32_t y) {
    return x - y;
}

// Implementation of the extern mul function
int32_t mul(int32_t x, int32_t y) {
    return x * y;
}

// Implementation of the extern div function
int32_t div(int32_t x, int32_t y) {
    return x / y;
}

// Implementation of the extern gt function
bool gt(int32_t x, int32_t y) {
    return x > y;
}

// Implementation of the extern eq function
bool eq(int32_t x, int32_t y) {
    return x == y;
}

// Implementation of the extern ge function
bool ge(int32_t x, int32_t y) {
    return x >= y;
}
