
def Id:
  (@(T): Type)-> @(Type), {
  This :: T;
  struct
    (This: Type) = T, // If This is present in `struct` then it denotes the receiver type.
  // struct           // The value of the receiver type can perform the method call.
    id:
      (x: This)-> This
  }
;

Id(i32)
  id:
    fn(x) -> x
;

// PROBLEM with this approach
// - It allows to create multiple instances of the same struct.  
// - Might exist duplicate instances of the same struct.  
// - How to handle the case for generic data types? Like Point(T) where T is a generic type.

// given(I32Id) :: Id(i32);
I32Id :: Id(i32);
I32Id.id(12); // Explicit call
12.id(); // Implicit method call
12.(I32Id.id)(); // Explicit method call

i32.Id(i32) = {
  This: i32,
  fn:
    fn(x) -> x
};


