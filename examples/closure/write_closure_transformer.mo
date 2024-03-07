type WriteClosure = {
  x: write i32;
};

implements Closure<WriteClosure, [i32], ()> {
  apply: (context: WriteClosure, [y]: [i32])=> {
    context.x = context.x + y;
  }
}

let test = (fn: [write](y: i32)=> (), y: i32)=> {
  fn(y)
}

let main = ()=> {
  var x = 1;
  test(WriteClosure {x: write x}, 3);
  x // x should be 4
}
