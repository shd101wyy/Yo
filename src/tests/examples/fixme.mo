extern
  add:
    (x: i32, y: i32)-> i32
;

def Container:
  (compt(X): Type, compt(Y): Type)-> compt(Type),
  enum
    Red(value: X),
    Green(value: Y),
    Blue(x: X, y: Y)
;
def use_container:
  forall(compt(X): Type, compt(Y): Type) .
    (c: Container(X, Y), x: X, y: Y)-> X,
  x
;
i32_i32_value := Container(i32, i32).Red(12);
use_container(i32_i32_value, 1, 2);
x := use_container(Container(i32, i32).Red(12), 1, 2);