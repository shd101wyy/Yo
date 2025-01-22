#include <iostream>

using namespace std;

int test(int &x) {
    x = x + 2;
    return x;
}

void modify(int arr[]) {
    arr[0] = 10;
}

int main() {
    cout << "Hello, World!" << endl;
    int arr[] = {1, 2, 3, 4, 5};
    modify(arr);
    cout << arr[0] << endl;

    auto s = "Hello";
    return 0;
}