#include <stdbool.h>
#include <stdint.h>
#include <stddef.h>
struct Unit {};
struct Unit unit = {};

// Module file:///home/yiyiwang/Workspace/mo/examples/codegen4.mo
// Module ID: mo5a01cf89
int32_t main();
int32_t mo5a01cf89_id_55d2be0b(int32_t mo5a01cf89_x_2);
float mo5a01cf89_id_78bf0757(float mo5a01cf89_x_2);

// Code
int32_t mo5a01cf89_id_55d2be0b(int32_t mo5a01cf89_x_2) {
  // block
  int32_t _mo5a01cf89_temp_1;
  _mo5a01cf89_temp_1 = mo5a01cf89_x_2;
  return _mo5a01cf89_temp_1;
  // end block
}
float mo5a01cf89_id_78bf0757(float mo5a01cf89_x_2) {
  // block
  float _mo5a01cf89_temp_1;
  _mo5a01cf89_temp_1 = mo5a01cf89_x_2;
  return _mo5a01cf89_temp_1;
  // end block
}
int32_t main() {
  // block
  int32_t _mo5a01cf89_temp_4;
  int32_t mo5a01cf89_x_3; // x
  int32_t _mo5a01cf89_temp_2;
  _mo5a01cf89_temp_2 = mo5a01cf89_id_55d2be0b(((int32_t)1) /* x */); 

  mo5a01cf89_x_3 = _mo5a01cf89_temp_2;

  float mo5a01cf89_y; // y
  float _mo5a01cf89_temp_3;
  _mo5a01cf89_temp_3 = mo5a01cf89_id_78bf0757(((float)2.3) /* x */); 

  mo5a01cf89_y = _mo5a01cf89_temp_3;

  _mo5a01cf89_temp_4 = ((int32_t)0);
  return _mo5a01cf89_temp_4;
  // end block
}
