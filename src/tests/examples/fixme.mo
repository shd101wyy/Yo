def Id:
  (compt(T): Type) -> compt(Type),
  interface
    (This: Type) = T,
    id: 
      (x: This) -> This
;
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

