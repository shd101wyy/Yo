extern
  add: 
    (x: i32, y: i32)-> i32
;

Point :: struct(i32);

// interface behaves similar to a struct
MyAdd :: interface // (MyAdd : Type)
  Self: Type,
  my_add: ((x: Self, y: Self)-> Self)
;

receiver :: MyAdd.Self; // unknown

// Each interface can only be implemented once.
impl MyAdd,
  Self: i32,
  my_add:
    fn(a, b)-> add(a, b)
;

receiver :: MyAdd.Self; // i32

// Call function from interface:
x := MyAdd.my_add(1, 2);

// Or use the method call
x := (1).my_add(2);

// Explict call
x := (1).(MyAdd.my_add)(2);

/*
// Function returning an interface
def Id(compt(T): Type): compt(Type),
  interface
    (Self: Type) = T,
    id: ((x: T)-> T)
;

// Call to interface function will be cached.
// So Id(i32) will always return the same interface.
// Id_i32 :: Id(i32);
impl Id(i32),
  id:
    fn(x)-> x
;
IdI32 :: Id(i32);
receiver :: Id(i32).Self; // i32
x := Id(i32).id(1);
x := IdI32.id(2);
x := (13).id();
x := (13).(Id(i32).id)();
*/

/*
// interface with default method
MyAdd2 :: interface
  (my_add: ((x: i32, y: i32)-> i32)) =
    fn(x, y)-> add(x, y)
;
x := MyAdd2.my_add(1, 2);

x := Id(i32).id(1);
x := (13).id();
x := (13).(Id(i32).id)();
*/

