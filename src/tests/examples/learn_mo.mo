extern
  SomeType: Type,
  SomeFree: Free,
  SomeLinear: Linear,
  // (---): i32,
  (+): ((lhs: i32, rhs: i32)-> i32),
  (-): ((lhs: i32, rhs: i32)-> i32),
  (*): ((lhs: i32, rhs: i32)-> i32),
  (/): ((lhs: i32, rhs: i32)-> i32)
  // TODO: Prevent the function overloading
  // (+): ((lhs: i32, rhs: i32)-> f32)
;
// SomeT := type (i32, y: SomeLinear);

mut(x) := 12;
mut(y) := 14;
z := ((x + y) * 4);
MyI32 := i32;
(x: MyI32) := 14;
x := true;
(x: boolean) := false;
y := x;

// Named Tuples
some_unit := ();
MyUnitType := type ();
(some_unit2 : MyUnitType) := ();
MyPointType := type (i32, i32);
MyPointType2 := (i32, i32);
point1 := (1, 2);
(point2: (i32, i32)) := (1, 3);
(point3: MyPointType) := (1, 4);

MyRecordType := type (x: i32, y: i32, boolean);
// (r : MyRecordType) := (y: 0, x: 12, true);
(r2 : MyRecordType) := (0, 12, true);
r3 := (x: 0, y: 12, true);
// error: Duplicate labels
// some_tuple := (x:12, x:13,);

// struct
Point := struct(x:i32, y:i32);

// (empty: EmptyVariant) := .Empty;
// empty := EmptyVariant.Empty;

// Point := type .Point(x: i32, y: i32);

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