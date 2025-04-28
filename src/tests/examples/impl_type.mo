extern
  add:
    (x: i32, y: i32)-> i32
;

Point :: struct
  x: i32,
  y: i32
;

a := Point(1, 2);
b := Point(3, 4);
x := (a.x `add` b.x);
y := (a.y `add` b.y);
// c := Point(x, y);
c := Point (a.x `add` b.x), b.y;
// c := (a + b);  

impl Point,
  (+):
    (fn(a: Point, b: Point): Point)->
      Point((a.x `add` b.x), (a.y `add` b.y ))
;

def add_points(a: Point, b: Point): Point,
  Point(a.x, b.y)
;

c := add_points(a, b);
c := (a + b);