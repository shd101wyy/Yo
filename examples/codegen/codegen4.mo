let id = <T>(x: T)-> T {
  x
}

let main = ()-> i32 {
  let x = id(1);
  let y = id(2.3);
  0
}
