def Point(compt(T): Type): compt(Type),
  struct(x: T, y: T)
;

def MakePoint(compt(T): Type, value: T): Point(T),
  Point(T)(x: value, y: value)
;

p := MakePoint(i32, 1);
p := MakePoint(boolean, true);
