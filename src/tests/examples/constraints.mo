// (constraints (that returns booleans)) => type_expression

equals : 
  (x: any(T: Type), y: T) -> 
    (using(Eq(T))) => boolean;
equals =
  fn(x, y) -> x == y;

show_and_compare :
  forall(compt(T): Type) .
    (x: T, y: T) -> 
        (Show(T), Eq(T)) => String;
show_and_compare =
  fn(x, y)->
    if (x == y),
      x.show(),
      "Different"
;