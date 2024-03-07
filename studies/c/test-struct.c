#include <stdio.h>

typedef struct struct1 {
    int a;
    int b;
} struct1;

typedef struct struct2 {
    int a;
} struct2;

void test(struct2 s) {
    int b;
    printf("%d %d\n", s.a, b);
}

int main() {
    struct1 s1 = {4, 6};
    test(*((struct2*)&s1));
    return 0;
}