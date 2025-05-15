def main:
  ()-> (), {
  Point :: struct(x: i32, y: i32);

  p := Point(3, 4); // Assign compt to runtime
  p :: Point(3, 4); // Assign compt to compt

  runt_value := 1;
  p := Point(runt_value, 4);
  // p :: Point(runt_value, 4); // Expect error

  Point :: struct(x: i32, (y: i32) = 12);
  p :: Point(14);
};