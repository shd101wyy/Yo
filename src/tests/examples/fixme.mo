// Just declare variables
extern
  add:
    (x: i32, y: i32)-> i32
;

// Define a module type
MyModule :: module
  (This: Type) == i32,
  my_add:
    (x: i32, y: i32)-> i32,
  id:
    (x: This)-> This
;

def some_func:
  (@(my_module): MyModule, x: i32)-> i32, {
  my_add :: my_module.my_add;
  my_add(x, 1)
}
;