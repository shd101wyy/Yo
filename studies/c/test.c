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

int32_t main() {
  // block
  int32_t _moad2268d4_temp_4;
  int32_t moad2268d4_x_3; // x
  int32_t _moad2268d4_temp_3;
  _moad2268d4_temp_3 = moad2268d4_add_da39a3ee(((int32_t)1) /* x */, ((int32_t)2) /* y */); 

  moad2268d4_x_3 = _moad2268d4_temp_3;

  _moad2268d4_temp_4 = moad2268d4_x_3;
  return _moad2268d4_temp_4;
  // end block
}
