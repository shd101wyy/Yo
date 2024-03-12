type WriteClosureContext = {
  x: write i32;
};

type WriteClosureArgs = {
  y: i32;
}

implements Closure<WriteClosureContext, WriteClosureArgs, ()> {
  apply: (context: WriteClosureContext, args: WriteClosureArgs)=> {
    context.x = context.x + args.y;
  }
}

let test = (fn: [write](y: i32)=> (), y: i32)=> {
  fn(y)
}

let main = ()=> {
  var x = 1;
  test(WriteClosureContext {x: write x}, 3);
  x // x should be 4
}
