let test = (fn: [own](y: i32)=> (), y: i32)=> () {
  fn(y);
}

let main = ()=> {
  var x = 1;
  var func = [own](y: i32)=> {
    x = x + y;
  };
  test(func, 2);
  // func.call(2); // Compiler error
  // x should still be 1.  
}
