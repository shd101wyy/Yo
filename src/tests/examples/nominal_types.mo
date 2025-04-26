Point1 :: struct(i32, i32);
Point2 :: struct(i32, i32);
// Point1 == Point2; // false
p1 := Point1 3, 4;
// (p2: Point2) := p1; // error: type mismatch