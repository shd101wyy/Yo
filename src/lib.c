#include <stdio.h>

// Unit type
struct Unit
{
} unit;

// String type
struct String
{
    char *data;
    int length;
    int size;
};

// Print a string to the console
int println(struct String *x)
{
    printf("%s\n", x->data);
    return 0;
}

int printlnd(int x)
{
    printf("%d\n", x);
    return 0;
}

int printlnsymbol(char* x) 
{
    printf("%s\n", x);
    return 0;
}