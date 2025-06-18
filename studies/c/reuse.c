#include <stdio.h>
#include <stdlib.h>

int main() {
    int *ptr = malloc(sizeof(int));
    printf("ptr = %p\n", (void *)ptr);
    free(ptr);

    // Create a new pointer
    int *new_ptr = malloc(sizeof(int));
    printf("new_ptr = %p\n", (void *)new_ptr);
    free(new_ptr);

    printf("equality check: %s\n", (ptr == new_ptr) ? "true" : "false");
    return 0;
}