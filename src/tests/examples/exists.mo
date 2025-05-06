/*
 * `exists` can be used to check:
 * - if a value of type exist at the compile-time scope.
 * - if an interface is implemented.  
 */
extern
  add:
    (x: i32, y: i32)-> i32
;

x :: 13;

c :: exists(i32); // true; Exists some value of type i32
c :: exists(x: i32); // true; Exists the variable x of type i32
c :: exists(y: i32); // false; Doesnt exist the variable y of type i32

y := 14;
c :: exists(y: i32); // false; Because y is not compile-time known.

c :: exists((i32, i32)-> i32); // true; Exists the function with signature (i32, i32)-> i32
c :: exists(add: ((i32, i32)-> i32)); // true; Exists the function "add" with signature (i32, i32)-> i32
c :: exists(sub: ((i32, i32)-> i32)); // false; Doesn't exist the function "sub" with signature (i32, i32)-> i32
c :: exists(f32); // false; Doesnt exist the value of type f32

// interface
Id :: interface
  This: Type,
  id: 
    This -> This
;
c :: exists(Id); // false; interface not implemented.
Id // implement the interface
  This: i32,
  id: 
    fn(x)-> x
;
c :: exists(Id); // true; interface implemented.

// Complex example:
c :: exists(
  Id,  // Exists the interface that is already implemented.  
  add: // Exists the function "add" with signature (i32, i32)-> i32 
    (i32, i32)-> i32,
  (i32, i32)-> i32, // Exists the function with signature (i32, i32)-> i32
  i32 // Exists the value of type i32
);
