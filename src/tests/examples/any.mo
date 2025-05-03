extern
  add:
    (x: i32, y: i32)-> i32
;

// Should we support this?
def return_self(x: any(T: Type)): T,
  x;

x := Id(12);
y := Id(true);

// With type constraints
def Add(compt(T): Type): compt(Type),
  interface
    (Self: Type) = T,
    (+):
      (Self, Self) -> Self
;
def add_data(x: any(T: Type), y: T):
    (Add(T)) => T,
  x + y
;

Point :: struct(x: i32, y: i32);
impl Add(Point),
  (+):
    fn(p1: Point, p2: Point) ->
      Point(p1.x + p2.x, p1.y + p2.y)
;

p1 :: Point(1, 2);
p2 :: Point(3, 4);
p3 := add_data(p1, p2);