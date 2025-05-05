extern
  add:
    (x: i32, y: i32)-> i32
;

// Explicitly define Type as function parameter. 
def id_fun :
  (compt(T): Type, x: T)-> T,
  x;
x := id_fun(i32, 12);
x := id_fun(boolean, true);

// QUESTION: Should we support "Scoped Type Variables"?
// Maybe we can just use `typeof` function to get the type of a variable.
def id_func :
  forall(compt(T): Type) .
    (x : T)-> T,
  // (xx : T) = x; // Use `T` inside the function body
  // xx
  x
;

x := id_func(12);
x := id_func(true); 

/*
// Anonymous function

anonymous_func :
  forall(compt(T): Type) .
    (x: T)-> T;
anonymous_func =
  fn(x)-> x;
*/

/*
// tuple
def tuple_func(x: (any(compt(T): Type), any(compt(Y): Type)), a: T, b: Y): (T, Y),
  (a, b)
;
x := tuple_func((12, true), 1, false);

// struct
def Container(compt(T): Type): compt(Type),
  struct(value: T)
;

def use_container(c: Container(any(X: Type)), x: X): X,
  // QUESTION: Can we use `T` for `x`?
  x
;
*/
/*
def Container(compt(T): Type): Type,
  struct(value: T)
;

def use_container(c: Container(any(T: Type)), x: T): T,
  // QUESTION: Can we use `T` for `x`?
  x
;
x := use_container(Container(i32)(13), 12);
x := use_container(Container(bool)(true), false);
*/