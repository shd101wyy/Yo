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
  (forall(@(T): Type), x: T, using(@(I): Id(T)))-> (),
  I.id(x)
;

given(IdInt) ::
  Id(i32)
    This: i32,
    id:
      fn(x) -> x
;

given(IdFloat) ::
  Id(f32)
    This: f32,
    id:
      fn(x) -> x
;

def given(IdPoint) :
  ( forall(@(T): Type), 
    using(@(I): Id(T))
  )-> @(Id(Point(T))),
  Id(Point(T))
    This: Point(T),
    id:
      fn(p) ->
        Point(T)(I.id(p.x), I.id(p.y))
;


id(13); // Implicit call
id(13, IdInt); // Explicit call

id(14.2); // Implicit call
id(14.2, IdFloat); // Explicit call

// QUESTION: How to implement the following?
id(Point(i32)(1, 2)); // Implicit call
id(Point(i32)(1, 2), IdPoint); // Implicit call 2

id(Point(i32)(1, 2), IdPoint(IdInt)); // Explicit call