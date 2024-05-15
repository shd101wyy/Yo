type WriteClosureContext = {
  x: @i32;
};

type WriteClosureArgs = {
  y: i32;
}

implements Closure<WriteClosureContext, WriteClosureArgs, ()> {
  apply: (context: WriteClosureContext, args: WriteClosureArgs)=> {
    *context.x = *context.x + args.y;
  }
}

let test = <T using Closure<T, WriteClosureArgs, ()>>(fn: T, y: i32)=> {
  apply(fn, WriteClosureArgs { y: y });
}

let main = ()=> i32 {
  var x = 1;
  test(WriteClosureContext { x: @x }, 3);
  x // x should be 4
}
