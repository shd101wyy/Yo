#include <stdbool.h>
#include <stdint.h>
#include <stddef.h>
struct Unit {};
struct Unit unit = {};

// Module file:///home/yiyiwang/Workspace/mo/examples/codegen2.mo
// Module ID: mo6399a6db
int32_t main();
int32_t main() {
  // block
  int32_t _mo6399a6db_temp_2;
  int32_t mo6399a6db_x; // x
  mo6399a6db_x = ((int32_t)1);
  int32_t mo6399a6db_y; // y

  // if
  int32_t _mo6399a6db_temp_1;
  if ((((int32_t)0) < mo6399a6db_x)) {
    // block
    _mo6399a6db_temp_1 = ((int32_t)1);
    // end block
  } else {
    // block
    _mo6399a6db_temp_1 = ((int32_t)2);
    // end block
  }
  // end if

  mo6399a6db_y = _mo6399a6db_temp_1;

  _mo6399a6db_temp_2 = (mo6399a6db_x + mo6399a6db_y);
  return _mo6399a6db_temp_2;
  // end block
}

