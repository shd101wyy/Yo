#include <stdio.h>
#include <stdbool.h>
int main () {
    char *x = "Hello";
    char *y = "Hello";
    printf("%p\n", x);
    printf("%p\n", y);
    // compare x and y
    printf("%d\n", x == y);
    return 0;
}