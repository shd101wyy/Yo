extern
  (==): ((i32, i32) -> boolean),
  (>): ((i32, i32)-> boolean),
  (*): ((i32, i32) -> i32),
  (+): ((i32, i32) -> i32),
  (-): ((i32, i32) -> i32)
;

factorial_fn :: ((x: i32) -> i32);


// Without given type
factorial := ((fn(x: i32): i32)-> {
  cond
    (x == 0) -> 1,
    (x > 0) -> (x * recur(x - 1))  
});
n := factorial(10);



// With given type
(factorial2 : factorial_fn) = 
  (fn(a: i32): i32) -> {
    cond
      (a == 0) -> 1,
      (a > 0) -> (a * recur(a - 1))  
  }
;



// With given type and fn implementaion has no type
(factorial3: factorial_fn) = 
  fn(a)-> {
    cond
      (a == 0) -> 1,
      (a > 0) -> (a * recur(a - 1))  
  }
;


def call_fn(cb: ((i32) -> i32), a: i32): i32,
  cb(a)
;
call_fn(factorial, 10);
call_fn((fn(x) -> x), 12);
