def Id:
  (compt(T): Type) -> compt(Type),
  interface
    (This: Type) = T,
    (id: ((x: This) -> This)) =
      fn(x) -> x
;

AnotherPoint :: struct(x: i32, y: i32);
AnotherIdPoint :: Id(AnotherPoint);
Id(AnotherPoint)
  This: i32 // We didn't use `AnotherPoint` as `This`
;
this :: AnotherIdPoint.This;
another_func :: AnotherIdPoint.id;
x := another_func(13);