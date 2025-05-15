extern 
  add: ((x: i32, y: i32)-> i32)
;
def add_2:
  (x: i32, y: i32)-> i32,
  add(x, y);

def add_3:
  (x: i32, y: i32, z: i32)-> i32,
  add(x, add(y, z));



x := add_2(1, 2);
x := (1 `add_2` 2);

x := add_3(1, 2, 3);
x := (1 `add_3` 2, 3);

