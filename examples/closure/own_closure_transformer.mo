type OwnClosure = {
  x: i32;
}

implements Closure<OwnClosure, [i32], ()> {
  apply: (context: OwnClosure, [y]: [i32])=> () {
    var {x} = context;
    x = x + y;
  }
}

let test = (fn: [own](y: i32)=> (), y: i32)=> () {
  fn(y);
}

let main = ()=> {
  var x = 1;
  var func = OwnClosure {
    x: x
  };
  test(func, 2);
}