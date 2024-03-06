let main = ()=> {
  var x = 1;
  var func = [own](y: i32)=> {
    x = x + y;
  };
  func.call(3);
  // func.call(); // Compiler error
  // x should still be 1.  
}
