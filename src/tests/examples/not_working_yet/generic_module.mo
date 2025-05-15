def Id:
  (@(T): Type)-> @(Type),
  module
    (This: Type) == T,
    id:
      (x: This)-> This
;

I32Id2 :: Id(i32)
  id:
    fn(x) -> x;

def Point:
  (@(T): Type)-> @(Type),
  struct
    x: T,
    y: T
;

def IdPoint:
  (forall(@(T): Type), implicit(@(I): Id(T))) -> @(Id(Point(T))),
  Id(Point(T))
    id:
      fn(p)->
        Point(T)(p.x, p.y)
;


/*
p :: Point(i32)(3, 4);
// p.id();
// ID(Point(i32)).id(p);
*/