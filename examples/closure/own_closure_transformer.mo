type OwnClosureContext = {
  x: i32;
}

type OwnClosureArgs = {
  y: i32;
}

implements Closure<OwnClosureContext, OwnClosureArgs, ()> {
  apply: (context: OwnClosureContext, {y}: OwnClosureArgs)=> () {
    var {x} = context;
    x = x + y;
  }
}

let test = (fn: [own](y: i32)=> (), y: i32)=> () {
  fn(y);
}

let main = ()=> {
  var x = 1;
  var func = OwnClosureContext {
    x: x
  };
  test(func, 2);
}