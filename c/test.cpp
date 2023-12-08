#include <iostream>

using namespace std;

int test(int x) {
    return x + 2;
}

int main() {
    int x = 1;
    int &x1 = x;
    int x2 = x1;

    cout << test(x1) << "\n";

    cout << "before\n";
    cout << x << "\n";
    cout << x1 << "\n";
    cout << x2 << "\n";

    x2 = 2;

    cout << "after\n";
    cout << x << "\n";
    cout << x1 << "\n";
    cout << x2 << "\n";

    return 0;
}