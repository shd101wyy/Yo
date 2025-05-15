
def id:
  ( forall(compt(T): Type),  
    x: T
  )-> T,
  x
;

x :: id(13);   // x: i32
x :: id(true); // x: boolean
x :: id(forall(i32), 14); // x: i32
