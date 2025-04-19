Shape := enum
  Circle(r: i32),
  Rectangle(w: i32, h: i32);

def area(shape: Shape): i32,
  match shape,
    Shape.Circle(r) -> 3 * (r * r),
    Shape.Rectangle(w, h) -> w * h
;