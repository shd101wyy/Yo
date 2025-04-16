/*
extern
  identity: ((T: Type, x: T) -> T)
;
*/

def SomeType(T: Type): Type,
  T;
(x: SomeType(i32)) := 42;
(x: SomeType(boolean)) := true;

def SomeTupleType(T: Type): Type,
  type (T,);

(x: SomeTupleType(i32)) := (42,);
(x: SomeTupleType(boolean)) := (true,);

/*
defn identity2(T: Type, x: T): T,
  x;

// FIXME: The type for `x` is not inferred correctly
x := identity2(i32, 42);
*/

/*
defn identity3(T: Type): i32,
  12;

x := identity3(i32);
*/