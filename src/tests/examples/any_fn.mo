extern
  add:
    (x: i32, y: i32)-> i32
;

def id_func(x: any(compt(T): Type)): T,
  x
;

x := id_func(12);
x := id_func(true);

/*
def complex_func(x: (any(T: Type), any(Y: Type)), a: T, b: Y): (T, Y),
  (a, b)
;
x := complex_func((12, true), 1, false);


def Container(compt(T): Type): Type,
  struct(value: T)
;

def use_container(c: Container(any(T: Type)), x: T): T,
  // QUESTION: Can we use `T` for `x`?
  x
;
x := use_container(Container(i32)(13), 12);
x := use_container(Container(bool)(true), false);
*/