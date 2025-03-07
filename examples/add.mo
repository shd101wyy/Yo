extern "C" {
  c_add: (x: i32, y: i32)-> i32;
}

export let add = (x: i32, y: i32): i32 -> {
  c_add(x, y)
}
