extern
  add: ((x: i32, y: i32)-> i32)
;

def my_add(x: i32, y: i32): i32, {
  a := x;
  b := y;
  c := add(a, b);
  c
}