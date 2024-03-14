type ReadClosureContext = {
  x: &i32;
}

type ReadClosureArgs = {
  y: i32;
}

implements Closure<ReadClosureContext, ReadClosureArgs, i32> {
  apply: (context: ReadClosureContext, args: ReadClosureArgs)=> i32 {
    context.x + args.y
  }
}

let test = (fn: [&](y: i32)=> i32, y: i32)=> i32 {
  fn(y)
}

let main = ()=> {
  let x = 1;
  test(ReadClosureContext { x: x }, 2);
}
