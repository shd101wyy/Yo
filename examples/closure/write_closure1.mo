let test = (fn: [@](y: i32)-> (), y: i32)-> {
  fn(y)
}

let main = ()-> {
  let mut x = 1;
  test([@](y: i32)-> {
    x = x + y;
  }, 3);
  x // x should be 4
}
