extern
  add: ((x: i32, y: i32)-> i32)
;

def my_add(mut(x): i32, y: i32): i32, {
  x = 12;
  a := x;
  b := y;
  c := add(a, b);
  c
};

def identity(compt(T): Type, x: T): T,
  x;
x := identity(i32, 12);
