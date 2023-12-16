#include <stdio.h>

extern int add(int a, int b);

// String type
struct String
{
    char *data;
    int length;
    int size;
};

union MyUnion
{
    int a;
    char b;
    int *c;
};

int main()
{
    struct String me;

    printf("%d\n", sizeof(me));
    printf("%d\n", sizeof(char *));

    union MyUnion u;
    u.a = 12;
    int x = u.a;

    return 0;
}