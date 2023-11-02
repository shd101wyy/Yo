#include <stdio.h>

extern int add(int a, int b);

// String type
struct String
{
    char *data;
    int length;
    int size;
};

int main()
{
    struct String me;

    printf("%d\n", sizeof(me));
    printf("%d\n", sizeof(char*));

    return 0;
}