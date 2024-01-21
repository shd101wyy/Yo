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

// Module file:///home/yiyiwang/Workspace/mo/examples/instance/instance2.mo
// Module ID: moc3a69f90
int32_t main();
moc3a69f90_Data_1_55d2be0b moc3a69f90_id_1_3e3e50e0(moc3a69f90_Data_1_55d2be0b moc3a69f90_x_2);

// enum Data<i32>
typedef struct {
  int tag;
  union {
    struct {
      int32_t value;
    } Value;
  } variant;
} moc3a69f90_Data_1_55d2be0b;

moc3a69f90_Data_1_55d2be0b moc3a69f90_id_1_3e3e50e0(moc3a69f90_Data_1_55d2be0b moc3a69f90_x_2) {
  // block
  moc3a69f90_Data_1_55d2be0b _moc3a69f90_temp_11;
  _moc3a69f90_temp_11 = (moc3a69f90_x_2);
  return _moc3a69f90_temp_11;
  // end block
}
int32_t main() {
  // block
  int32_t _moc3a69f90_temp_15;
  moc3a69f90_Data_1_55d2be0b moc3a69f90_x_3; // x
  moc3a69f90_Data_1_55d2be0b _moc3a69f90_temp_12;
  _moc3a69f90_temp_12 = (moc3a69f90_Data_1_55d2be0b){ 
    .tag = 0,
    .variant = {
      .Value = {
        .value = (((int32_t)1))
      }
    }
  };

  moc3a69f90_x_3 = (_moc3a69f90_temp_12);

  moc3a69f90_Data_1_55d2be0b moc3a69f90_y; // y
  moc3a69f90_Data_1_55d2be0b _moc3a69f90_temp_13;
  _moc3a69f90_temp_13 = moc3a69f90_id_1_3e3e50e0((moc3a69f90_x_3) /* x */); 

  moc3a69f90_y = (_moc3a69f90_temp_13);

  moc3a69f90_Data_1_55d2be0b moc3a69f90_z; // z
  moc3a69f90_Data_1_55d2be0b _moc3a69f90_temp_14;
  _moc3a69f90_temp_14 = moc3a69f90_id_1_3e3e50e0((moc3a69f90_x_3) /* x */); 

  moc3a69f90_z = (_moc3a69f90_temp_14);

  _moc3a69f90_temp_15 = (((int32_t)0));
  return _moc3a69f90_temp_15;
  // end block
}
