let test = (fn: [read](y: i32)=> i32, y: i32)=> i32 {
  fn(y)
}

let main = ()=> {
  let x = 1;
  test([read](y: i32)=> {
    x + y
  })
}
