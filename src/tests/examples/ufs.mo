// Uniform Function Calls
// This example demonstrates the use of uniform function calls
extern
  (+): ((x: i32, y: i32)-> i32)
;

def add(x: i32, y: i32): i32,
  x + y;

x := 12;
y := x.add(3);