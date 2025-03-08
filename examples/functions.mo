extern "C" {
  c_add: (x: i32, y: i32)-> i32;
}

let assign = ()-> {
  let x: _ = 1;
}

let some_func1: (x: i32)-> i32 
= (x: i32)-> {
  let b = x;
  b
}
let some_func2: (x: i32)-> i32 
= (x: _)-> {
  let b = x;
  b
}

let some_func3: (x: i32)-> i32
= (x)-> {
  let b = x;
  b
}

let some_func3: (x: i32)-> i32
= (x)-> {
  let a = x;
  let b = a;
  b
}