#include <stdio.h>
#include <stdlib.h>
#include <string.h>

int main() {
    char* x = "你好世界!";
    size_t len = strlen(x);
    printf("你好世界! %d", len);
    
    return 0;
}