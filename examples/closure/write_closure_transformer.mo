type WriteClosure = {
  x: write i32;
};

let call = (context: WriteClosure, y: i32)=> {
  var {x} = context;
  x = x + y;
}

let main = ()=> {
  var x = 1;
  call(WriteClosure {x: write x}, 3);
  x
}