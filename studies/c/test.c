#include <stdbool.h>
#include <stdint.h>
#include <stddef.h>
struct Unit {};
struct Unit unit = {};

// Module file:///home/yiyiwang/Workspace/mo/examples/codegen/codegen6.mo
// Module ID: moad2268d4
int32_t main();

// Code
inline int32_t moad2268d4_add_da39a3ee(int32_t moad2268d4_x_2, int32_t moad2268d4_y_2) { return moad2268d4_x_2 + moad2268d4_y_2; }

inline int32_t moad2268d4_1_da39a3ee(int32_t moad2268d4_x_5, int32_t moad2268d4_y_5) { return moad2268d4_x_5 + moad2268d4_y_5; }

int32_t main() {
  // block
  int32_t _moad2268d4_temp_8;
  int32_t moad2268d4_x_6; // x
  int32_t _moad2268d4_temp_5;
  _moad2268d4_temp_5 = moad2268d4_add_da39a3ee(((int32_t)1) /* x */, ((int32_t)2) /* y */); 

  moad2268d4_x_6 = _moad2268d4_temp_5;

  int32_t moad2268d4_y_6; // y
  int32_t _moad2268d4_temp_6;
  _moad2268d4_temp_6 = moad2268d4_1_da39a3ee(((int32_t)3) /* x */, ((int32_t)4) /* y */); 

  moad2268d4_y_6 = _moad2268d4_temp_6;

  int32_t _moad2268d4_temp_7;
  _moad2268d4_temp_7 = moad2268d4_1_da39a3ee(moad2268d4_x_6 /* x */, moad2268d4_y_6 /* y */); 

  _moad2268d4_temp_8 = _moad2268d4_temp_7;
  return _moad2268d4_temp_8;
  // end block
}


