extern
  add: 
    (x: i32, y: i32)-> i32
;

Point :: struct(i32);

// interface behaves similar to a struct
MyAdd :: interface                  // (MyAdd : Type)
  my_add: ((x: i32, y: i32)-> i32)
;

// Each interface can only be implemented once.
impl MyAdd,
  my_add:
    fn(a, b)-> add(a, b)
;

// Can function from interface:
x := MyAdd.my_add(1, 2);

// Or use the method call
x := (1).my_add(2);

// Explict call
x := (1).(MyAdd.my_add)(2);


/*
// interface with default method
MyAdd2 :: interface
  (my_add: ((x: i32, y: i32)-> i32)) =
    fn(x, y)-> add(x, y)
;
x := MyAdd2.my_add(1, 2);


// function returning interface
def Id(compt(T): Type): compt(Type),
  interface
    id: ((x: T)-> T)
;

// Call to interface function will be cached.
// So Id(i32) will always return the same interface.  
impl Id(i32),
  id:
    fn(x)-> x
;
x := Id(i32).id(1);
x := (13).id();
x := (13).(Id(i32).id)();
*/



