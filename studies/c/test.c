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
  int32_t mo949dbe77_tmp; // tmp
  mo949dbe77_tmp = (*(mo949dbe77_y_2));

  // assignment
  *(mo949dbe77_y_2) = *(mo949dbe77_x_2);

  // assignment
  *(mo949dbe77_x_2) = mo949dbe77_tmp;

  _mo949dbe77_temp_13 = (unit);
  return _mo949dbe77_temp_13;
  // end block
}
int32_t main() {
  // block
  int32_t _mo949dbe77_temp_17;
  int32_t mo949dbe77_x_3; // x
  mo949dbe77_x_3 = (((int32_t)1));

  int32_t mo949dbe77_y_3; // y
  mo949dbe77_y_3 = (((int32_t)2));

  int32_t* mo949dbe77_xRef; // xRef
  int32_t* _mo949dbe77_temp_14;
  _mo949dbe77_temp_14 = &(mo949dbe77_x_3);
  mo949dbe77_xRef = (_mo949dbe77_temp_14);

  int32_t* mo949dbe77_yRef; // yRef
  int32_t* _mo949dbe77_temp_15;
  _mo949dbe77_temp_15 = &(mo949dbe77_y_3);
  mo949dbe77_yRef = (_mo949dbe77_temp_15);

  int32_t mo949dbe77_a; // a
  mo949dbe77_a = (*(mo949dbe77_xRef));

    struct Unit _mo949dbe77_temp_16;
  _mo949dbe77_temp_16 = mo949dbe77_swap_da39a3ee((&*(mo949dbe77_xRef)) /* x */, (&*(mo949dbe77_yRef)) /* y */); 

  _mo949dbe77_temp_17 = (mo949dbe77_x_3);
  return _mo949dbe77_temp_17;
  // end block
}
