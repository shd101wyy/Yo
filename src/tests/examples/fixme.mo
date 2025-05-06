/*
def define_struct_with_default_field:
  (compt(T): Type, compt(value): T, runtime_value: T) -> (), {
  Point :: struct
    (x: T) = value,
    (y: T) = value
  ;
  p := Point(x: value, y: value);
};

define_struct_with_default_field(i32, 0, 0);
*/

def SomeStructWithDefaultValue:
  (compt(T): Type, compt(value): T)-> compt(Type),
  struct(
    (x: T) = value
  )
;
SomeStruct :: SomeStructWithDefaultValue(i32, 12);
x :: SomeStruct();
a :: x.x;