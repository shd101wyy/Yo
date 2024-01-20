#include <stdbool.h>
#include <stdint.h>
#include <stddef.h>
struct Unit {};
struct Unit unit = {};

// Module file:///home/yiyiwang/Workspace/mo/examples/type/type3.mo
// Module ID: mob6ca533f
struct Unit main();

// Code
// type MyI32
typedef int32_t mob6ca533f_MyI32_1_da39a3ee;

// type MyInt
typedef union {
  int8_t;
  int16_t;
  int32_t;
} mob6ca533f_MyInt_1_da39a3ee;

// type Coord
typedef struct {
  int32_t x;
  int32_t y;
} mob6ca533f_Coord_1_da39a3ee;

// type AnotherCoord
typedef union {
  mob6ca533f_Coord_1_da39a3ee;
  struct {
    float x;
    float y;
  };
} mob6ca533f_AnotherCoord_1_da39a3ee;

// type Coord3D
typedef struct {
  mob6ca533f_Coord_1_da39a3ee;
  struct {
    int32_t z;
  };
} mob6ca533f_Coord3D_1_da39a3ee;

struct Unit main() {
  // block
  struct Unit _mob6ca533f_temp_13;
  mob6ca533f_MyI32_1_da39a3ee mob6ca533f_x; // x
  mob6ca533f_MyI32_1_da39a3ee _mob6ca533f_temp_11;
  _mob6ca533f_temp_11 = ((mob6ca533f_MyI32_1_da39a3ee) ((int32_t)12));
  mob6ca533f_x = (_mob6ca533f_temp_11);

  mob6ca533f_Coord_1_da39a3ee mob6ca533f_coord; // coord
  mob6ca533f_Coord_1_da39a3ee _mob6ca533f_temp_12;
  _mob6ca533f_temp_12 = ((mob6ca533f_Coord_1_da39a3ee) {.x = ((int32_t)12), .y = ((int32_t)13)});
  mob6ca533f_coord = (_mob6ca533f_temp_12);

  _mob6ca533f_temp_13 = (unit);
  return _mob6ca533f_temp_13;
  // end block
}


