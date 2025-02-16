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

let test = (fn: [=](y: i32)-> (), y: i32)-> () {
  fn(y);
}

let main = ()-> {
  let mut x = 1;
  let mut func = OwnClosureContext {
    x: x
  };
  test(func, 2);
}