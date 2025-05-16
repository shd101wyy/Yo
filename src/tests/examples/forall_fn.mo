extern
  add:
    (x: i32, y: i32)-> i32
;

// Explicitly define Type as function parameter. 
def id_fun :
  (@(T): Type, x: T)-> T,
  x;
x := id_fun(i32, 12);
x := id_fun(boolean, true);

// QUESTION: Should we support "Scoped Type Variables"?
// Maybe we can just use `typeof` function to get the type of a variable.
def id_func :
  (forall(@(T): Type),
    x : T)-> T, {
  // (xx : T) = x; // Use `T` inside the function body
  // xx
  xx := x;

  (mut(xxx) : typeof(x)) = xx;
  xxx = x;

  x
};

x := id_func(12);
x := id_func(true); 


// Anonymous function
anonymous_func :
  (forall(compt(T): Type),
    x: T)-> T;
anonymous_func =
  fn(a)-> a;
x := anonymous_func(12);
x := anonymous_func(true);


// tuple
def tuple_func:
  (forall(compt(T): Type, compt(Y): Type), 
    x: (T, Y), a: T, b: Y)-> (T, Y),
  (a, b)
;
x := tuple_func((12, true), 1, false);


// struct
def Container:
  (compt(T): Type)-> compt(Type),
  struct(value: T)
;

def use_container:
  (forall(compt(X): Type), 
    c: Container(X), x: X)-> X,
  x
;

i32_container_value := Container(i32)(12);
x := use_container(i32_container_value, 13);
x := use_container(Container(i32)(13), 12);
x := use_container(Container(boolean)(true), false);