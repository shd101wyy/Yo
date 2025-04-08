extern {
  SomeType: Type,
  SomeFree: Free,
  MyI32: i32,
  (---): i32,
  // (): Free,
  (+): ((lhs: i32, rhs: i32)-> i32)
};
mut(x) := 12;
mut(y) := x;

// MyI32 := i32;
// (a : MyI32) := 16;
/*
defn add(x: i32, y: i32): i32,
  x + y;
result := add(3, 4);
*/