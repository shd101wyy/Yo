// Complicated case
// struct type inside tuple
Complex :: type (s: struct(x: i32, y: boolean),);

SomeStruct :: Complex.0;
SomeStruct2 :: Complex.s;
x := SomeStruct(1, true);
(y: SomeStruct) = Complex.0(1, false);

(c: Complex) = (_(3, true),);

Complex :: struct(x: (i32, boolean), y: i32);
(c: Complex) = _((3, true), 4);
c := Complex((3, true), 4);
x := c.x;