#include <stdio.h>

int main() {
    char *x = "Hi";
    char *y = "Hi";
    if (x == y) {
        printf("Same\n");
    } else {
        printf("Different\n");
    }
}