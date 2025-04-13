/*
SomeI32 := i32;

extern
  SomeLinear: Linear,
  SomeI32: i32,
  SomeFunc: ((T: Type)-> T)
;

MyLinear := Linear;
SomeTuple2 := type (x: i32,);
*/

extern
  SomeLinear: Linear,
  SomeI32: i32,
  SomeFunc: ((T: Type)-> T)
;

x := 12;
X := type i32;
my_tuple := type (x: X, y: i32);
SomeTuple := type (x: Linear,);
SomeTuple2 := type (x: SomeLinear,);

/*
MyType := (Type <: (Display,))
MyType
  - type: Type(1)
  - value: Type <: Display

MyType: (Type <: (Display,))

MyType
  - type: Type <: Display
  - value: some( Type <: Display )

MyI32 := i32;
MyI32
  - type: Free
  - value: i32

MyI32: i32;
MyI32
  - type: i32
  - value: unknown
*/