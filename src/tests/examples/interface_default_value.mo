def Id:
  (compt(T): Type) -> compt(Type),
  interface
    (This: Type) = T,
    (id: ((x: This) -> This)) =
      fn(x) -> x
;

// scenairo 1.
Point :: struct(x: i32, y: i32);
IdPoint :: Id(Point);
Id(Point)
  // No need to set `This`
  // as it is defaulted to `Point`
  id: 
    fn(x) -> x
;

this :: IdPoint.This;

p :: Point(1, 2);
func :: Id(Point).id;
q := func(p);
q := Id(Point).id(p);
q := IdPoint.id(p);
q := p.id();

// scenairo 2.
AnotherPoint :: struct(x: i32, y: i32);
AnotherIdPoint :: Id(AnotherPoint);
Id(AnotherPoint)
  This: i32 // We didn't use `AnotherPoint` as `This`
;
this :: AnotherIdPoint.This;
another_func :: AnotherIdPoint.id;
x := another_func(13);