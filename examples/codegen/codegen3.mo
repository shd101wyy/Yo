let add = (x: i32, y: i32)=> i32 {
  x + y
}

let main = ()=> i32 {
  let x = 1;
  let y = 2;
  add(add(x, 3), add(y, 4))
}