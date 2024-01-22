#include <stdbool.h>
#include <stdint.h>
#include <stddef.h>
struct Unit {};
struct Unit unit = {};


// Module file:///home/yiyiwang/Workspace/mo/std/builtins.mo
// Module ID: mo7f32697e

// Module file:///home/yiyiwang/Workspace/mo/std/data/arithmetic.mo
// Module ID: mod3bddfa5

// Module file:///home/yiyiwang/Workspace/mo/std/data/primitive/i32.mo
// Module ID: mo86a322ea

// Module file:///home/yiyiwang/Workspace/mo/std/data/option.mo
// Module ID: mo53dd88a6

// Module file:///home/yiyiwang/Workspace/mo/std/prelude.mo
// Module ID: mo213980cc

// Module file:///home/yiyiwang/Workspace/mo/examples/type/anonymous_record1.mo
// Module ID: mo9dbd615d
int32_t main();

// type Coord
typedef struct {
  int32_t x;
  int32_t y;
} mo9dbd615d_Coord_1_da39a3ee;

int32_t main() {
  { // block
    int32_t _mo9dbd615d_temp_21;
    mo9dbd615d_Coord_1_da39a3ee mo9dbd615d_coord; // coord
    mo9dbd615d_Coord_1_da39a3ee _mo9dbd615d_temp_11;
    _mo9dbd615d_temp_11 = ((mo9dbd615d_Coord_1_da39a3ee) {.x = ((int32_t)3), .y = ((int32_t)4)});
    mo9dbd615d_coord = (_mo9dbd615d_temp_11);

    
    { // block
      struct Unit _mo9dbd615d_temp_15;
      int32_t mo9dbd615d_x; // x
      mo9dbd615d_x = (mo9dbd615d_coord.x);

      int32_t* mo9dbd615d_xRef; // xRef
      int32_t* _mo9dbd615d_temp_12;
      _mo9dbd615d_temp_12 = &(      mo9dbd615d_coord.x);
      mo9dbd615d_xRef = (_mo9dbd615d_temp_12);

      // assignment
      int32_t _mo9dbd615d_temp_13;
      _mo9dbd615d_temp_13 = (((int32_t)(*(mo9dbd615d_xRef))) + ((int32_t)(((int32_t)1))));

      *(mo9dbd615d_xRef) = (_mo9dbd615d_temp_13);

      _mo9dbd615d_temp_15 = (unit);
    } // end block

    
    { // block
      struct Unit _mo9dbd615d_temp_20;
      mo9dbd615d_Coord_1_da39a3ee* mo9dbd615d_coordRef; // coordRef
      mo9dbd615d_Coord_1_da39a3ee* _mo9dbd615d_temp_16;
      _mo9dbd615d_temp_16 = &(mo9dbd615d_coord);
      mo9dbd615d_coordRef = (_mo9dbd615d_temp_16);

      int32_t mo9dbd615d_x_1; // x
      mo9dbd615d_x_1 = (mo9dbd615d_coordRef->x);

      int32_t* mo9dbd615d_xRef_1; // xRef
      int32_t* _mo9dbd615d_temp_17;
      _mo9dbd615d_temp_17 = &(      mo9dbd615d_coordRef->x);
      mo9dbd615d_xRef_1 = (_mo9dbd615d_temp_17);

      // assignment
      int32_t _mo9dbd615d_temp_18;
      _mo9dbd615d_temp_18 = (((int32_t)(*(mo9dbd615d_xRef_1))) + ((int32_t)(((int32_t)1))));

      *(mo9dbd615d_xRef_1) = (_mo9dbd615d_temp_18);

      _mo9dbd615d_temp_20 = (unit);
    } // end block

    _mo9dbd615d_temp_21 = (((int32_t)0));
    return _mo9dbd615d_temp_21;
  } // end block
}
