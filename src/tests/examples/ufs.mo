// Uniform Function Calls
// This example demonstrates the use of uniform function calls
extern
  (add): ((x: i32, y: i32)-> i32),
  (add_three): ((x: i32, y: i32, z: i32)-> i32)
;

x := 12;
y := x.add(3);
z := add(y: 1, x: 2);
o := (1).add_three 2, 3;
o := (1).add_three z: 3, y: 2;