def SomeStruct(compt(T): Type): compt(Type),
  struct(x: T)
;

(x: SomeStruct(i32)) = SomeStruct(i32)(1);
(x: SomeStruct(i32)) = _(1);
(y: SomeStruct(i32)) = x;

// Check memorization
/// MyI32 := i32;
/// (z: SomeStruct(MyI32)) := x;
