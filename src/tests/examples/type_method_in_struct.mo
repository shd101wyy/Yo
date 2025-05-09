extern
  add:
    (x: i32, y: i32)-> i32
;

Point :: struct
  x: i32,
  y: i32,

  (def (+):
    (a: Self, b: Self)-> Self,
    Self((a.x `add` b.x), (a.y `add` b.y))
  ),

  (def add:
    (a: Self, b: Self)-> Self,
    Self((a.x `add` b.x), (a.y `add` b.y))
  ),

  (def new:
    () -> Self,
    Self(0, 0)
  ),

  (def create:
    (x: i32, y: i32) -> Self,
    Self(x, y)
  )
;

a := Point(1, 2);
b := Point(3, 4);
x := (a.x `add` b.x);
y := (a.y `add` b.y);
// c := Point(x, y);
c := Point (a.x `add` b.x), b.y;
// c := (a + b);

def add_points:
  (a: Point, b: Point)-> Point,
  Point(a.x, b.y)
;

c := add_points(a, b);
c := (a + b);

a := Point.new();
b := Point.create(3, 4);
c := Point.add(a, b);
d := a.add(b);
