#include <stdio.h>

typedef struct Ints
{
    int a;
    int b;
    int c;
} Ints;

int main()
{
    // array
    int arr1[] = {1, 2, 3};
    // int arr2[3] = arr1; // This will not work in C, arrays cannot be copied directly
    // Instead, we can copy elements one by one
    int arr3[3];
    for (int i = 0; i < 3; i++)
    {
        arr3[i] = arr1[i];
    }
    arr3[0] = 4; // Modifying an element in the copied array
    printf("arr1: %d, %d, %d %p\n", arr1[0], arr1[1], arr1[2], arr1);
    printf("arr3: %d, %d, %d %p %p\n", arr3[0], arr3[1], arr3[2], arr3, &arr3[0]);

    // struct
    Ints ints1 = {1, 2, 3};
    Ints ints2 = ints1; // Copying the structure
    ints2.a = 4;        // Modifying a field in the copied structure
    printf("ints1: %d, %d, %d, %p\n", ints1.a, ints1.b, ints1.c, &ints1);
    printf("ints2: %d, %d, %d, %p\n", ints2.a, ints2.b, ints2.c, &ints2);

    return 0;
}