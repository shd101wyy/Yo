extern
  (+) : ((i32, i32)-> i32),
  (-) : ((i32, i32)-> i32),
  (*) : ((i32, i32)-> i32),
  (/) : ((i32, i32)-> i32),
  (==): ((i32, i32)-> boolean)
;

def factoral(x: i32): i32,
  cond
    (x == 0) -> 1,
    true     -> (factoral(x - 1) * x);

x := factoral(x: 12);