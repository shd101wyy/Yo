#include <iostream>

typedef struct IntRef {
    int &ref;
} IntRef;

int main() {
    int a = 5;
    IntRef ref = {a};
    int b = 10;
    ref.ref = b;
    ref.ref -= 1;
    std::cout << a << std::endl;
    std::cout << b << std::endl;
    return 0;
}