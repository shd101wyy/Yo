def main:
  ()-> (), {
  Shape :: enum
    Circle(r: i32),
    Rectangle(w: i32, h: i32);
  rect := Shape.Rectangle(3, 4);

  // NOTE: We now only support destructuring enum in `match`
  /*
  // Destructuring by position
  Shape.Rectangle(m, n) := rect;

  // Destructuring by label
  Shape.Rectangle(.w, .h) := rect;

  // Renaming
  Shape.Rectangle(.w: a, .h: b) := rect;

  // Inferred enum variant
  */
};