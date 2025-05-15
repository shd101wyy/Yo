extern
  add: 
    (x: i32, y: i32)-> i32
;

Point :: struct(i32);

MY_ADD :: module
  (This: Type) == i32,
  my_add: ((x: This, y: This)-> This),
  new_self: (()-> This),
  new_self2: ((boolean)-> This);
;

// receiver :: MyAdd.Self; // unknown
// Each interface can only be implemented once.
MyAdd :: MY_ADD(
  my_add:
    fn(a, b)-> add(a, b),
  new_self:
    fn()-> 0,
  new_self2:
    fn(flag)-> 0
);

receiver :: MyAdd.This; // i32

def main:
  ()-> (), {
  // Call function from interface:
  x := MyAdd.my_add(1, 2);
  x := MyAdd.new_self();
  x := MyAdd.new_self2(true);
  
  // Or use the method call
  x := (1).my_add(2);
  
  // Explict call
  x := (1).(MyAdd.my_add)(2);

  // This is prohibited because `boolean` is not the receiver type of MyAdd interface
  // (true).new_self2(); // not ok
  MyAdd.new_self2(true); // ok
  MyAdd.new_self2(false); // ok
  
  /*
  // Function returning an interface
  def Id :
    (compt(T): Type) -> compt(Type),
    interface
      This: Type,
      id: ((x: This)-> This)
  ;

  // Call to interface function will be cached.
  // So Id(i32) will always return the same interface.
  Id_i32 :: Id(i32);
  Id(i32)
    This: i32,
    id:
      fn(x)-> x
  ;

  IdI32 :: Id(i32);
  receiver :: Id(i32).This; // i32
  x := Id(i32).id(1);
  x := IdI32.id(2);
  x := (13).id();
  x := (13).(Id(i32).id)();
  */  
}
