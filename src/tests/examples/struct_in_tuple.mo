// Complicated case
// struct type inside tuple
def main:
  ()-> (), {
  SomeStruct :: struct(x: i32, y: boolean);
  Complex :: type (s: SomeStruct,);

  x := SomeStruct(1, true);
  (y: SomeStruct) = _(1, false);

  (c: Complex) = (_(3, true),);

  Complex :: struct(x: (i32, boolean), y: i32);
  (c: Complex) = _((3, true), 4);
  c := Complex((3, true), 4);
  x := c.x;
};