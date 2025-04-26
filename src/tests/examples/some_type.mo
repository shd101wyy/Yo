extern
  // identity: ((T: Type, x: T) -> T)
  SomeLinear: Linear,
  return_value_of_type: ((compt(X): Type)-> X)
;

def SomeType(compt(T): Type): compt(Type),
  type (T,);
(x: SomeType(i32)) = (12,);

def identity(compt(Y): Type, x: SomeType(Y)): SomeType(Y),
  x;
x := identity(i32, (42,));

def NestedFunction(compt(T): Type): T, {
  def identity2(compt(Y): Type, x: Y): Y,
    x;
  a := return_value_of_type(T);
  x := identity2(T, return_value_of_type(T));
  x := identity2(T, a);
  y := identity2(i32, 12);
  x
  // a
};
x := NestedFunction(i32);
y := NestedFunction(SomeLinear);

/*
(x: SomeType(i32)) := 42;
(x: SomeType(boolean)) := true;

def SomeTupleType(T: Type): Type,
  type (T,);

(x: SomeTupleType(i32)) := (42,);
(x: SomeTupleType(boolean)) := (true,);

def NestedFunction(T: Type): i32, {
  def identity2(Y: Type, x: Y): Y,
    x;
  x := identity2(i32, 42);
  0
};
*/

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