#include <iostream>

using namespace std;

int test(int x) {
    x = x + 2;
    return x;
}

int main() {
    int x = 1;
    int &x1 = x;
    auto z = x1;
    int y = test(x1);
    cout << x << endl;
    return 0;
}