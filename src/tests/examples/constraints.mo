// (constraints) => type_expression

equals : 
  forall(compt(T): Type) .
    (Eq(T)) =>
      (x: T, y: T) -> boolean;
equals =
  fn(x, y) -> x == y;

show_and_compare :
  forall(compt(T): Type) .
    (Show(T), Eq(T)) =>
      (x: T, y: T) -> String;
show_and_compare =
  fn(x, y)->
    if (x == y),
      x.show(),
      "Different"
;
