#include <stdbool.h>
#include <stdint.h>
#include <stddef.h>
struct Unit {};
struct Unit unit = {};

// Module file:///home/yiyiwang/Workspace/mo/examples/enum/enum1.mo
// Module ID: mo2df43d4e
struct Unit main();

// Code
// enum Color
typedef struct {
  int tag;
  union {
    struct {
    } Red;
    struct {
    } Green;
    struct {
    } Blue;
  } variant;
} mo2df43d4e_Color_1_da39a3ee;

// enum MyOption<i32>
typedef struct {
  int tag;
  union {
    struct {
    } None;
    struct {
      int32_t value;
    } Some;
  } variant;
} mo2df43d4e_MyOption_1_55d2be0b;

// enum MyOption<f32>
typedef struct {
  int tag;
  union {
    struct {
    } None;
    struct {
      float value;
    } Some;
  } variant;
} mo2df43d4e_MyOption_1_78bf0757;

struct Unit main() {
  // block
  struct Unit _mo2df43d4e_temp_15;
  mo2df43d4e_Color_1_da39a3ee mo2df43d4e_r; // r
  mo2df43d4e_Color_1_da39a3ee _mo2df43d4e_temp_11;
  _mo2df43d4e_temp_11 = (mo2df43d4e_Color_1_da39a3ee){ 
    .tag = 0,
    .variant = {
      .Red = {

      }
    }
  };

  mo2df43d4e_r = (_mo2df43d4e_temp_11);

  mo2df43d4e_MyOption_1_55d2be0b mo2df43d4e_x; // x
  mo2df43d4e_MyOption_1_55d2be0b _mo2df43d4e_temp_12;
  _mo2df43d4e_temp_12 = (mo2df43d4e_MyOption_1_55d2be0b){ 
    .tag = 1,
    .variant = {
      .Some = {
        .value = (((int32_t)12))
      }
    }
  };

  mo2df43d4e_x = (_mo2df43d4e_temp_12);

  mo2df43d4e_MyOption_1_55d2be0b mo2df43d4e_y; // y
  mo2df43d4e_MyOption_1_55d2be0b _mo2df43d4e_temp_13;
  _mo2df43d4e_temp_13 = (mo2df43d4e_MyOption_1_55d2be0b){ 
    .tag = 0,
    .variant = {
      .None = {

      }
    }
  };

  mo2df43d4e_y = (_mo2df43d4e_temp_13);

  mo2df43d4e_MyOption_1_78bf0757 mo2df43d4e_z; // z
  mo2df43d4e_MyOption_1_78bf0757 _mo2df43d4e_temp_14;
  _mo2df43d4e_temp_14 = (mo2df43d4e_MyOption_1_78bf0757){ 
    .tag = 0,
    .variant = {
      .None = {

      }
    }
  };

  mo2df43d4e_z = (_mo2df43d4e_temp_14);

  _mo2df43d4e_temp_15 = (unit);
  return _mo2df43d4e_temp_15;
  // end block
}
