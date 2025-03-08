extern "C" {
  c_add: (x: i32, y: i32)-> i32;
}

let assign = ()-> {
  let x: _ = 1;
}

let some_func1: (x: i32)-> i32 
= (a: i32)-> {
  let b = a;
  b
}
let some_func2: (x: i32)-> i32 
= (a: _)-> {
  let b = a;
  b
}

let some_func3: (x: i32)-> i32
= (a)-> {
  let b = a;
  b
}