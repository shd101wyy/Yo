type WriteClosureContext = {
  x: @i32;
};

type WriteClosureArgs = {
  y: i32;
}

implements Closure<WriteClosureContext, WriteClosureArgs, ()> {
  apply: (context: WriteClosureContext, args: WriteClosureArgs)-> {
    context.x = context.x + args.y;
  }
}

let test = (fn: [@](y: i32)-> (), y: i32)-> {
  fn(y)
}

let main = ()-> i32 {
  let mut x = 1;
  test(WriteClosureContext {x: x}, 3);
  x // x should be 4
}
