let test = (fn: [&](y: i32)-> i32, y: i32)-> i32 {
  fn(y)
}

let main = ()-> {
  let x = 1;
  test([&](y: i32)-> {
    x + y
  })
}
