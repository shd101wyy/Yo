#include <stdlib.h>

inline int add(int a, int b)
{
  return a + b;
}

int main( int argc, char **argv )
{
  int x = atoi(argv[1]);  
  int y = 2;
  int z = add(x, y);
  int z2 = x + y;
  return z + z2;
}