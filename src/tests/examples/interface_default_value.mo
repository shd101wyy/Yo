 def Id:
  (compt(T): Type) -> compt(Type),
  interface
    (This: Type) = T,
    id: 
      (x: This) -> This
;

Point :: struct(x: i32, y: i32);
Id(Point)
  // No need to set `This`
  // as it is defaulted to `Point`
  id: 
    fn(x) -> x
;

p :: Point(1, 2);

q :: Id(Point).id(p);
q :: p.id();
