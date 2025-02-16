type OwnClosureContext = {
  x: i32;
}

type OwnClosureArgs = {
  y: i32;
}

implements Closure<OwnClosureContext, OwnClosureArgs, ()> {
  apply: (context: OwnClosureContext, args: OwnClosureArgs)-> () {
    context.x = context.x + args.y;
  }
}

let test = <T using Closure<T, OwnClosureArgs, ()>>(fn: T, y: i32)-> () {
  apply(fn, OwnClosureArgs {y: y})
}

let main = ()-> {
  let mut x = 1;
  let mut func = OwnClosureContext {
    x: x
  };
  test(func, 2);
}