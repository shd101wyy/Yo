extern
  add:
    (x: i32, y: i32)-> i32
;

// Normal function
def add_1:
  (x: i32, y: i32)-> i32,
  add(x, y)
;
add_1(3, 4);
add_1(x: 3, y: 4);
add_1(x: 4, 3);

// Generic function
def id:
  (compt(T): Type, x: T)-> T,
  x;
id(i32, 12);
id(T: i32, x: 12);
