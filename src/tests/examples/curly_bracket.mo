Point :: struct(x: i32, y: i32);

p := Point(3, 4);
(p: Point) = _(3, 4);
(p: Point) = {x: 3, y: 4};

x := 1;
y := 2;
(p: Point) = {x, y};
