def Id:
  (@(T): Type)-> @(Type),
  interface // or module?
    (This: Type) = T,
    id:
      (x: This)-> This
;

I32Id :: Id(i32);
I32Id2 :: Id(i32) // calling interface will implement it and return itself.
  id:
    fn(x) -> x;
// I32Id == I32Id2; // true;

def Point:
  (@(T): Type)-> @(Type),
  struct
    x: T,
    y: T
;

forall(@(T): Type) .
  Id(Point(T))
    id:
      fn(p)-> Point(T)(p.x, p.y)
;


/*
p :: Point(i32)(3, 4);
// p.id();
// ID(Point(i32)).id(p);
*/