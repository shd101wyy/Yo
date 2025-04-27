extern
  (eq): ((i32, i32) -> boolean),
  (gt): ((i32, i32)-> boolean),
  (mul): ((i32, i32) -> i32),
  (add): ((i32, i32) -> i32),
  (sub): ((i32, i32) -> i32)
;

factorial_fn :: ((x: i32) -> i32);


// Without given type
factorial := ((fn(x: i32): i32)-> {
  cond
    (x `eq` 0) -> 1,
    (x `gt` 0) -> (x `mul` recur(x `sub` 1))  
});
n := factorial(10);



// With given type
(factorial2 : factorial_fn) = 
  (fn(a: i32): i32) -> {
    cond
      (a `eq` 0) -> 1,
      (a `gt` 0) -> (a `mul` recur(a `sub` 1))  
  }
;



// With given type and fn implementaion has no type
(factorial3: factorial_fn) = 
  fn(a)-> {
    cond
      (a `eq` 0) -> 1,
      (a `gt` 0) -> (a `mul` recur(a `sub` 1))  
  }
;


def call_fn(cb: ((i32) -> i32), a: i32): i32,
  cb(a)
;
call_fn(factorial, 10);
call_fn((fn(x) -> x), 12);
