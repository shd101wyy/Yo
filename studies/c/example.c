#include <stdint.h>

typedef struct
{
  int tag;
  union
  {
    struct
    {
      int value;
    } Some;
    struct
    {
    } None;
  } variant;
} Option;

typedef struct
{
  int tag;
} Color;

// type Coord
typedef struct {
  int32_t x;
  int32_t y;
} Coord;

// type AnotherCoord
typedef union {
  Coord;
  struct {
    float x;
    float y;
  };
} mob6ca533f_AnotherCoord_1_da39a3ee;

// type Coord3D
typedef struct {
  Coord;
  struct {
    int32_t z;
  };
} Coord3D;


int main()
{
  Coord3D coord = {.x = 1, .y = 2, .z = 3};
  return 0;
}