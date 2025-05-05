extern
  (mul): ((i32, i32)-> i32)
;

Color :: enum Red, Green, Blue;

def color_to_i32 :
  (color: Color) -> i32,
  match color,
    .Red -> 0,
    .Green -> 1,
    .Blue -> 2
;


Shape :: enum
  Circle(r: i32),
  Rectangle(w: i32, h: i32);

def area :
  (shape: Shape) -> i32,
  match shape,
    .Circle(r) -> (3 `mul` (r `mul` r)),
    .Rectangle(w, h) -> (w `mul` h)
;