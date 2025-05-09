// Functor works similarly to the one in OCaml
// QUESTION: Should we make the module instance singleton?

// ID is a function that returns a module type
def ID:
  (@(T): Type)-> @(Type),
  type module
    (This: Type) = T,
    id:
      (x: This)-> This
;

// IntId implements ID(i32)
(given(IntId) : ID(i32)) =
  {
    This: i32,
    id:
      fn(x)-> x
  }
;

def Point(@(T): Type): @(Type),
  struct  
    x: T, 
    y: T,

    (def Id:
      ()-> ID(Self),
      ID(Self)
        This: Self,
        id:
          fn(p)-> Self(p.x, p.y)
    )
;

def MakePointId:
  (
    @(T): Type
  )-> ID(Point(T)), {
  PointType :: Point(T);
  ID(PointType)
    This: PointType,
    id:
      fn(p)-> PointType(p.x, p.y)
}
;

def generic_id:
  ( forall(@(T): Type),
    x: T,
    using(@(Id): ID(T))
  )-> T,
  Id.id(x)
;
generic_id(13); // IntId is used

// How to call generic_id with Point?
generic_id(Point(i32)(3, 4), using(Point(i32).Id()));
generic_id(Point(i32)(3, 4), using(MakePointId(i32)));
