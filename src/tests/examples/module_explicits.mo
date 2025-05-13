def Point:
  (@(T): Type)-> @(Type),
  module
    x: T,
    y: T
;

def Id:
  (@(This): Type)-> @(Type),
  module
    (This: Type) = This,
    id:
      (This)-> This
;

def id:
  (forall(@(T): Type), x: T, @(I): Id(T))-> (),
  I.id(x)
;

IdInt ::
  Id(i32)
    This: i32,
    id:
      fn(x) -> x
;

IdFloat ::
  Id(f32)
    This: f32,
    id:
      fn(x) -> x
;

def IdPoint :
  ( forall(@(T): Type), 
    @(I): Id(T)
  )-> @(Id(Point(T))),
  Id(Point(T))
    This: Point(T),
    id:
      fn(p) ->
        Point(T)(I.id(p.x), I.id(p.y))
  ;

show(13, IdInt);
show(13.4, IdFloat);
show(Point(i32)(1, 2), IdPoint(IdInt));
