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
// mut(x) := 12;
// mut(y) := 14;
// z := ((x + y) * 4);
MyI32 := i32;
(x: MyI32) := 14;
x := true;
(x: boolean) := false;
y := x;

some_unit := ();
MyUnitType := type ();
MyPointType := type (i32, i32);
MyPointType2 := (i32, i32);
point1 := (1, 2);
(point2: (i32, i32)) := (1, 3);
(point3: MyPointType) := (1, 4);

MyRecordType := type {x: i32, y: i32};

/*
defn add(x: i32, y: i32): i32,
  x + y;

defn factorial(x: i32): i32,
  cond 
    (x == 0) -> 1, 
    true     -> (factorial(x - 1) * x);

Point := struct {
  x: i32,
  y: i32,
};
p := Point {x: 1, y: 2};
*/

// MyI32 := i32;
// (a : MyI32) := 16;
/*
defn add(x: i32, y: i32): i32,
  x + y;
result := add(3, 4);
*/