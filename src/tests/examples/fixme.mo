def Id:
  (@(T): Type)-> @(Type),
  interface // or module?
    (This: Type) = T,
    id:
      (x: This)-> This
;

def Point:
  (@(T): Type)-> @(Type),
  struct(
    x: T,
    y: T
  )
;

forall(@(X): Type) .
  Id(Point(X))
;


(forall(@(T): Type) . Id(Point(T)))
  id:
    fn(p)-> {
      P :: typeof(p);
      P(p.x, p.y)
    }
;

Id(i32)
  id:
    fn(p) -> p
;


p :: Point(i32)(3, 4);
// p.id();
Id(Point(i32)).id(p);
// Id(i32).id(13);
