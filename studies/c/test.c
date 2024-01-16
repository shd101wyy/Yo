#include <stdbool.h>
#include <stdint.h>
#include <stddef.h>
struct Unit {};
struct Unit unit = {};

// Module file:///home/yiyiwang/Workspace/mo/examples/function/swap1.mo
// Module ID: mo949dbe77
struct Unit mo949dbe77_swap_da39a3ee(int32_t* mo949dbe77_x_2, int32_t* mo949dbe77_y_2);
int32_t main();

// Code
struct Unit mo949dbe77_swap_da39a3ee(int32_t* mo949dbe77_x_2, int32_t* mo949dbe77_y_2) {
  // block
  struct Unit _mo949dbe77_temp_13;
  int32_t* mo949dbe77_tmp; // tmp
  mo949dbe77_tmp = mo949dbe77_y_2;

    *mo949dbe77_y_2 = *mo949dbe77_x_2;

    *mo949dbe77_x_2 = *mo949dbe77_tmp;

  _mo949dbe77_temp_13 = unit;
  return _mo949dbe77_temp_13;
  // end block
}
int32_t main() {
  // block
  int32_t _mo949dbe77_temp_17;
  int32_t mo949dbe77_x_3; // x
  mo949dbe77_x_3 = ((int32_t)1);

  int32_t mo949dbe77_y_3; // y
  mo949dbe77_y_3 = ((int32_t)2);

    struct Unit _mo949dbe77_temp_16;
  int32_t* _mo949dbe77_temp_14;
  _mo949dbe77_temp_14 = &(mo949dbe77_x_3);
  int32_t* _mo949dbe77_temp_15;
  _mo949dbe77_temp_15 = &(mo949dbe77_y_3);
  _mo949dbe77_temp_16 = mo949dbe77_swap_da39a3ee(_mo949dbe77_temp_14 /* x */, _mo949dbe77_temp_15 /* y */); 

  _mo949dbe77_temp_17 = mo949dbe77_x_3;
  return _mo949dbe77_temp_17;
  // end block
}
