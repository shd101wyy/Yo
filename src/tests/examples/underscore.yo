// _ can only be used to infer a type value.
def main:
  ()-> (), {
  Point :: struct(i32, i32);
  (p: Point) = Point(3, 4);
  (p: Point) = _(3, 4); // _ should be inferred as Point

  Color :: enum Red, Green, Blue;
  (c: Color) = Color.Red;
  (c: Color) = .Red;

  Shape :: enum
    Circle(r: i32),
    Rectangle(w: i32, h: i32);
  (c: Shape) = Shape.Circle(3);
  (c: Shape) = .Rectangle(3, 4);

  def color_identity:
    (color: Color)-> Color,
    color;
  c := color_identity(Color.Red);
  c := color_identity(.Red);

  NestedEnum :: enum
    Level1(
      x: enum Level2(i32)
    );
  n := NestedEnum.Level1(.Level2(3));
  (n : NestedEnum) = .Level1(.Level2(3));
};