// contextual parameters, aka implicit parameters
def generic_add:
  ( // define type parameters
    forall(@(T): Type), 
    x: T, y: T,
    // defining contextual parameters 
    using(
      @(add):
        (T, T)-> T 
    )
  )-> T,
  add(x, y)
;

def given(add2):
  (x: i32, y: i32)-> i32,
  x + y;

generic_add(1, 2); // Implicitly uses the `add2` function
generic_add(1, 2, using(add2)); // Explicitly uses the `add2` function
