Shape :: enum
  Circle(r: i32),
  Rectangle(width: i32, height: i32)
;

c :: Shape.Circle(12);
c := Shape.Circle(12);

runt_value := 13;

// c :: Shape.Circle(runt_value); // Expected error
c := Shape.Circle(runt_value); // Expected error

Color :: enum
  Red, Green, Blue
;
c :: Color.Red;
c := Color.Green;