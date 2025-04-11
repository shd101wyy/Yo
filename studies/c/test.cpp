#include <iostream>

using namespace std;

int test(int& x) {
    x = x + 2;
    auto y = x;
    return x;
}

void modify(int arr[]) {
    arr[0] = 10;
}

int& foo(const int& ref) {
    std::cout << ref; // Dangling reference!
    return ref;
}

int main() {
    /*
    cout << "Hello, World!" << endl;
    int arr[] = {1, 2, 3, 4, 5};
    modify(arr);
    cout << arr[0] << endl;

    auto s = "Hello";

    const char *s1 = "Hello";
    char *s2 = "Hi";

    char s3[] = "Hello";
    */
    foo(1 + 2); // Temporary `3` dies after the call arg is passed

    return 0;
}