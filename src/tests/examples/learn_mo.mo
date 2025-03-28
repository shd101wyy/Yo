PI := comptime(3.14159265358979323846);

// Compile-time function execution
// Consider making the syntax more explicit:
fn factorial(n: i32): i32,
  if n <= 1, then: 1, else: (n * recur(n - 1));

// This will be computed during compilation
FACTORIAL_10 := comptime factorial(10);  // More consistent syntax without parentheses
                                         // Also consider a distinct naming convention for compile-time constants like ALL_CAPS

// Type-level computation using comptime
// Consider more intuitive syntax for type parameters:
fn Matrix(T: Type, comptime(ROWS): usize, comptime(COLS): usize): Type,
  Array(Array(T, COLS), ROWS);
// ^ Removing parentheses around ROWS makes it consistent with COLS

// Create a 3x3 matrix of integers
(mat : Matrix(i32, 3, 3)) := [
  [1, 2, 3],
  [4, 5, 6],
  [7, 8, 9]
];

// Compile-time if statements
// Consider a dedicated compile-time condition syntax:
DEBUG_MODE := comptime if debug_build(), true, false;
fn debug_print(msg: String),
  comptime if DEBUG_MODE,  // More consistent with other uses of comptime
    then: std.println(msg),
    else: ();