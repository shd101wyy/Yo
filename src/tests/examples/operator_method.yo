extern
  add : 
    (x: i32, y: i32)-> i32
;

Add :: interface
  (+):
    (x: i32, y: i32)-> i32
;

impl Add,
  (+):
    fn(x, y)-> add(x, y)
;

// Operator will be called as the method
x := (1 + 2);
// is equavalent to
x := (1.(+)(2));
// is equavalent to
x := (1.(Add.(+))(3));