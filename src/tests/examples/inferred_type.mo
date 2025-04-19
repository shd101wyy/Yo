Point1 := struct(x: i32, y: i32);
Point2 := struct(i32, i32);

x := Point1(3, 4);
y := Point2(5, 6);

Point3 := Point1;

(z: Point2) := y;
(z: Point3) := x;


Color := enum Red, Green, Blue;
(r: Color) := Color.Red;

Shape := enum
  Circle(r: i32),
  Rectangle(w: i32, h: i32);
(c: Shape) := Shape.Circle(5);
c := Shape.Rectangle(h: 1, w: 2);

anonymous := (struct(i32, i32))(3, 4);
anonymous := (enum Circle(r: i32), Rectangle(w: i32, h: i32)).Circle(5);


// (x: Point1) := _(3, 4);