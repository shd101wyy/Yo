#include <iostream>

int main() {
    int x = 1;

    int &r1 = x;
    r1 = 2;
    std::cout << x << std::endl;

    int &r2 = r1;
    r2 = 3;
    std::cout << x << std::endl;

    auto r3 = r1;
    auto &r4 = r1;

    return 0;
}