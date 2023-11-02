#include <stdio.h>

extern int add(int a, int b);

struct MyStruct
{
    char name[30];
};

int main()
{
    struct MyStruct me;
    char myName[30] = "John Doe";

    printf("%d\n", sizeof(me));
    printf("%d\n", sizeof(myName));

    return 0;
}