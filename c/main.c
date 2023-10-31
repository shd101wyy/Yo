#include <stdio.h>

extern int add(int a, int b);

int main()
{
    printf("Add 3 + 4 = %d", add(3, 4));
    return 0;
}