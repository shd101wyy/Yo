type ReadClosure = {
  x: read i32;
}

implements Closure<ReadClosure, [i32], i32> {
  apply: (context: ReadClosure, [y]: [i32])=> i32 {
    context.x + y
  }
}

let test = (fn: [read](y: i32)=> i32, y: i32)=> i32 {
  fn(y)
}

let main = ()=> {
  let x = 1;
  test(ReadClosure { x: read x }, 2);
}
