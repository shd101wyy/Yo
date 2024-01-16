#include <iostream>

using namespace std;

int test(int &x) {
    x = x + 2;
    return x;
}

int main() {
    int x = 1;
    int &y = x;
    auto z = y;
    int &m = y;
    test(x);
    test(y);
    test(z);
    test(m);
}