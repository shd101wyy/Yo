#include <stdio.h>
#include <stdlib.h>

int safeDivide(int x,
               int y,
               int (*throw)(const char *, void (*)(int), void (*)(void)),
               void (*resume)(int result),
               void (*abort)(void))
{
    if (y == 0)
    {
        int result = throw("Division by zero", resume, abort); // Might abort the code below
        return result;
    }
    else
    {
        return x / y;
    }
}

void handleException(const char *message,
                    void (*resume)(int result),
                    void(*abort))
{
    printf("Exception: %s\n", message);
    resume(0);
}

int effectHandler()
{
    {
        int x = 12;
        int y = 0;
        int z = safeDivide(x, y, handleException);
        printf("z = %d\n", z);
    }
}

int main()
{
    effectHandler();
    return 0;
}