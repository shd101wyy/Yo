#include <stdbool.h>
#include <stdint.h>
#include <stddef.h>
struct Unit {};
struct Unit unit = {};

// Module file:///home/yiyiwang/Workspace/mo/examples/enum/enum3.mo
// Module ID: moa93acf49
int32_t main();

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
} moa93acf49_Color_1_da39a3ee;

int32_t main() {
  // block
  int32_t _moa93acf49_temp_15;
  moa93acf49_Color_1_da39a3ee moa93acf49_r; // r
  moa93acf49_Color_1_da39a3ee _moa93acf49_temp_11;
  _moa93acf49_temp_11 = (moa93acf49_Color_1_da39a3ee){ 
    .tag = 0,
    .variant = {
      .Red = {

      }
    }
  };

  moa93acf49_r = (_moa93acf49_temp_11);

  int32_t moa93acf49_num; // num

  // match
  int32_t _moa93acf49_temp_12;
  switch ((moa93acf49_r).tag) {
    case 1: // Green
            // block
      _moa93acf49_temp_12 = (((int32_t)1));
      // end block

      break;
    case 0: // Red
            // block
      _moa93acf49_temp_12 = (((int32_t)2));
      // end block

      break;
    default: // *
            // block
      _moa93acf49_temp_12 = (((int32_t)3));
      // end block

      break;
  };


  moa93acf49_num = (_moa93acf49_temp_12);

  _moa93acf49_temp_15 = (moa93acf49_num);
  return _moa93acf49_temp_15;
  // end block
}
