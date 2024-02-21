#include <stdio.h>
#include <setjmp.h>

int main()
{
    jmp_buf env;

    printf("Before setjmp\n");
    int result = setjmp(env);
    printf("After setjmp\n");

    printf("Result: %d\n", result);
    if (result != 0)
    {
        printf("Error: %d\n", result);
        return 1;
    }
    else
    {
        printf("Before longjmp\n");
        longjmp(env, 12);
        printf("After longjmp\n");
    }
    return 0;
}