#include <stdbool.h>
#include <stdint.h>
#include <stddef.h>
struct Unit
{
};
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

// Module file:///home/yiyiwang/Workspace/mo/examples/instance/instance1.mo
// Module ID: mo271ace47
int32_t mo271ace47_id_1_da39a3ee(int32_t mo271ace47_x_2);
int32_t main();

int32_t mo271ace47_id_1_da39a3ee(int32_t mo271ace47_x_2)
{
  // block
  int32_t _mo271ace47_temp_12;
  int32_t _mo271ace47_temp_11;
  _mo271ace47_temp_11 = (((int32_t)(mo271ace47_x_2)) + ((int32_t)(((int32_t)2))));

  _mo271ace47_temp_12 = (_mo271ace47_temp_11);
  return _mo271ace47_temp_12;
  // end block
}
int32_t main()
{
  // block
  int32_t _mo271ace47_temp_14;
  int32_t mo271ace47_x_3; // x
  int32_t _mo271ace47_temp_13;
  _mo271ace47_temp_13 = mo271ace47_id_1_da39a3ee((((int32_t)12)) /* x */);

  mo271ace47_x_3 = (_mo271ace47_temp_13);

  _mo271ace47_temp_14 = (mo271ace47_x_3);
  return _mo271ace47_temp_14;
  // end block
}
