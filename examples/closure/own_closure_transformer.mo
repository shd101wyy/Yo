type OwnClosure = {
  x: i32;
}

let call = (context: OwnClosure, y: i32)=> {
  var {x} = context;
  x = x + y;
}

let main = ()=> {
  var x = 1;
  var func = OwnClosure {
    x: x
  };
  call(func, 3);
}