// Just declare variables
extern
  add:
    (x: i32, y: i32)-> i32
;

// Define a module type
MyModule :: module
  This: Type,
  my_add:
    (x: i32, y: i32)-> i32,
  id:
    (x: This)-> This
;

// Define a module instance
(compt(my_module) : MyModule) = MyModule
  This: i32,
  my_add:
    fn(x, y)->
      add(x, y)
    ,
  id:
    fn(x) -> x
;

some_this :: my_module.This;
some_id :: my_module.id;
x := some_id(13);
x := my_module.id(13);

_( id: id2 ) :: my_module;
{ id: id3 } :: my_module;
x := id2(13);
x := id3(13);