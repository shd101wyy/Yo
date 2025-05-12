def Point:
  (@(T): Type)-> @(Type),
  struct
    x: T,
    y: T
;

Show ::
  struct
    This: Type,
    show:
      (This)-> String
;

def show:
  (using(S: Show), x: S.This)-> (),
  S.show(x)
;

given(ShowI32) :: Show
  This: i32,
  show:
    fn(x) -> string_of_int(x)
;

given(ShowFloat) :: Show
  This: f32,
  show:
    fn(x) -> string_of_float(x)
;

given(ShowPoint) ::
  (S: Show) => Show
    This: Point(S.This),
    show:
      fn(p) ->
        "(" + 
        S.show(p.x) + 
        ", " + 
        S.show(p.y) + 
        ")"
;