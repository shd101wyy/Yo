extern "C" {
  c_add: (x: i32, y: i32)-> i32;
}

export let add = (x: i32, y: i32): i32 -> { // annotate the return type
  c_add(x, y)
}

export let add2 = (x: i32, y: i32)-> { // infer the return type
  c_add(x, y)
}

export let add3: (x: i32, y: i32)-> i32 
= (a: i32, b: i32): i32-> { // annotate the return type
  c_add(a, b)
}

export let add4: (x: i32, y: i32)-> i32 
= (a: i32, b: i32)-> { // infer the return type
  c_add(a, b)
}