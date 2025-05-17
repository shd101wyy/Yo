def Point:
  (compt(T): Type) -> compt(Type),
  struct(x: T, y: T)
;

def MakePoint:
  (compt(T): Type, value: T) -> Point(T),
  Point(T)(x: value, y: value)
;

def main:
  ()-> (), {
  p := MakePoint(i32, 1);
  p := MakePoint(boolean, true);
}