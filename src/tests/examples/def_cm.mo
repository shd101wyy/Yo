( .MyAdd, ) := import("./def_interface.mo");

// Some extern function
extern
  add: 
    (x: i32, y: i32)-> i32
;


// Define a struct
Cm :: struct(v: i32);

// Implement the interface for the struct

impl MyAdd(Cm),
  my_add:
    fn(x, y)-> Cm(add(x.v, y.v))
;
