#include <stdbool.h>
#include <stdint.h>
#include <stddef.h>
struct Unit {};
struct Unit unit = {};

// Module file:///home/yiyiwang/Workspace/mo/examples/codegen3.mo
// Module ID: mode5d662f
int32_t mode5d662f_add(int32_t mode5d662f_x_2, int32_t mode5d662f_y_2);
int32_t main();
int32_t mode5d662f_add(int32_t mode5d662f_x_2, int32_t mode5d662f_y_2) {
  // block
  int32_t _mode5d662f_temp_1;
  _mode5d662f_temp_1 = (mode5d662f_x_2 + mode5d662f_y_2);
  return _mode5d662f_temp_1;
  // end block
}

int32_t main() {
  // block
  int32_t _mode5d662f_temp_5;
  int32_t mode5d662f_x_3; // x
  mode5d662f_x_3 = ((int32_t)1);

  int32_t mode5d662f_y_3; // y
  mode5d662f_y_3 = ((int32_t)2);

  int32_t _mode5d662f_temp_4;
  int32_t _mode5d662f_temp_2;
  _mode5d662f_temp_2 = mode5d662f_add(mode5d662f_x_3 /* x */, ((int32_t)3) /* y */); 

  int32_t _mode5d662f_temp_3;
  _mode5d662f_temp_3 = mode5d662f_add(mode5d662f_y_3 /* x */, ((int32_t)4) /* y */); 

  _mode5d662f_temp_4 = mode5d662f_add(_mode5d662f_temp_2 /* x */, _mode5d662f_temp_3 /* y */); 

  _mode5d662f_temp_5 = _mode5d662f_temp_4;
  return _mode5d662f_temp_5;
  // end block
}
