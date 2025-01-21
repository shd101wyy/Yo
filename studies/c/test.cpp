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
    auto t = "Hello";
    test(x);
    test(y);
    test(z);
    test(m);

    int arr[] = {1, 2, 3, 4, 5};
    auto ref = &arr;
    auto ref2 = &arr[0];
}