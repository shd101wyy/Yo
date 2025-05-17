let add = (x: i32, y: i32)-> i32 {
  x + y
}

let useAdd = (cb: (x:i32, y:i32)-> i32)-> i32 {
  cb(1, 2)
}

let useClosureAdd = (cb: [&](x:i32, y:i32)-> i32) -> i32 {
  cb(1, 2)
}

let test = ()-> {
  // Top level function
  let add2 = add;
  useAdd(add);
  useAdd(add2);

  // Closure
  let closureAdd = (x: i32, y: i32)-> i32 { x + y };
  let closureAdd2 = closureAdd;
  useClosureAdd(closureAdd);
  useClosureAdd(closureAdd2);
  ()
}