Point :: struct
  (x: i32) = 0,
  (y: i32) = 0
;

p := Point(y: 1, x: 2);
p := Point();
p := Point(13);
p := Point(x: 2);
p := Point(y: 3);


SomeTuple :: type (x: i32, y: i32);
(t: SomeTuple) = (1, 2);
