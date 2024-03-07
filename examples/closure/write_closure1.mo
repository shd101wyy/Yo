let test = (fn: [write](y: i32)=> (), y: i32)=> {
  fn(y)
}

let main = ()=> {
  var x = 1;
  test([write](y: i32)=> {
    x = x + y;
  }, 3);
  x // x should be 4
}
