extern
  add: 
    (x: i32, y: i32)-> i32
;

// The attribute "Self" of `trait` is the
// receiver type of the trait being implemented for.  
MyAdd :: trait Self: Type,
  my_add: ((x: Self, y: Self)-> Self)
;

// Each trait can only be implemented once.
MyAdd Self: i32, 
  my_add:
    fn(a, b)-> add(a, b)
;

// Call function from trait:
x := MyAdd.my_add(1, 2);

// Or use the method call
x := (1).my_add(2);

// Explicit call
x := (1).(MyAdd.my_add)(2);

// Function returning a trait
def Id(compt(T): Type): compt(Type),
  trait (Self: Type) = T,
    id: ((x: Self)-> Self)
;
// Implement the trait returning from a function
Id(i32)
  id: 
    fn(x)-> x
;
IdI32 :: Id(i32);
self :: IdI32.Self; // self is i32
x := Id(i32).id(1);
x := IdI32.id(2);
x := (13).id();
x := (13).(Id(i32).id)();

