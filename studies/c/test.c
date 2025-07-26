#include <stdbool.h>
#include <stdint.h>
#include <stddef.h>
struct Unit {};
struct Unit unit = {};


// Module file:///home/yiyiwang/Workspace/yo/std/builtins.yo
// Module ID: mo7f32697e

// Module file:///home/yiyiwang/Workspace/yo/std/data/arithmetic.yo
// Module ID: mod3bddfa5

// Module file:///home/yiyiwang/Workspace/yo/std/data/primitives/i32.yo
// Module ID: mo86a322ea

// Module file:///home/yiyiwang/Workspace/yo/std/data/option.yo
// Module ID: mo53dd88a6

// Module file:///home/yiyiwang/Workspace/yo/std/prelude.yo
// Module ID: mo213980cc

// Module file:///home/yiyiwang/Workspace/yo/examples/type/slice.yo
// Module ID: mo2b15e616
int32_t main();

int32_t main() {
  { // block
    int32_t _mo2b15e616_temp_20;
    int32_t* mo2b15e616_arr; // arr
    mo2b15e616_arr = ((int32_t[5]) {((int32_t)1), ((int32_t)2), ((int32_t)3), ((int32_t)4), ((int32_t)5)});

    
    { // block
      struct Unit _mo2b15e616_temp_14;
      int32_t* mo2b15e616_first; // first
      int32_t* _mo2b15e616_temp_11;
      _mo2b15e616_temp_11 = &(mo2b15e616_arr[((int32_t)0)]);
      mo2b15e616_first = (_mo2b15e616_temp_11);

      // assignment
      int32_t _mo2b15e616_temp_12;
      _mo2b15e616_temp_12 = (((int32_t)(*(mo2b15e616_first))) + ((int32_t)(((int32_t)10))));

      *(mo2b15e616_first) = (_mo2b15e616_temp_12);

      _mo2b15e616_temp_14 = (unit);
    } // end block

    
    { // block
      struct Unit _mo2b15e616_temp_19;
      int32_t** mo2b15e616_ref; // ref
      int32_t** _mo2b15e616_temp_15;
      _mo2b15e616_temp_15 = &(mo2b15e616_arr);
      mo2b15e616_ref = (_mo2b15e616_temp_15);

      int32_t* mo2b15e616_first_1; // first
      int32_t* _mo2b15e616_temp_16;
      _mo2b15e616_temp_16 = &(*(mo2b15e616_ref)[((int32_t)0)]);
      mo2b15e616_first_1 = (_mo2b15e616_temp_16);

      // assignment
      int32_t _mo2b15e616_temp_17;
      _mo2b15e616_temp_17 = (((int32_t)(*(mo2b15e616_first_1))) + ((int32_t)(((int32_t)10))));

      *(mo2b15e616_first_1) = (_mo2b15e616_temp_17);

      _mo2b15e616_temp_19 = (unit);
    } // end block

    _mo2b15e616_temp_20 = (mo2b15e616_arr[((int32_t)0)]);
    return _mo2b15e616_temp_20;
  } // end block
}
