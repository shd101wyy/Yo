/*
extern
  identity: ((T: Type, x: T) -> T)
;
*/

defn identity2(T: Type, x: T): T,
  x;
x := identity2(i32, 42);

/*
defn identity3(T: Type): i32,
  12;

x := identity3(i32);
*/