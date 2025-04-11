extern {
  SomeType: Type,
  SomeFree: Free,
  SomeLinear: Linear,
  MyI32: i32,
  (---): i32,
  // (): Free,
  (+): ((lhs: i32, rhs: i32)-> i32),
  (-): ((lhs: i32, rhs: i32)-> i32),
  (*): ((lhs: i32, rhs: i32)-> i32),
  (/): ((lhs: i32, rhs: i32)-> i32),
  // TODO: Prevent the function overloading
  // (+): ((lhs: i32, rhs: i32)-> f32)
};
mut(x) := 12;
mut(y) := 14;
z := ((x + y) * 4);
x := true;

/*
defn add(x: i32, y: i32): i32,
  x + y;

defn factorial(x: i32): i32,
  cond 
    (x == 0) -> 1, 
    true     -> (factorial(x - 1) * x);
*/

// MyI32 := i32;
// (a : MyI32) := 16;
/*
defn add(x: i32, y: i32): i32,
  x + y;
result := add(3, 4);
*/