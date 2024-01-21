let swap = (x: write i32, y: write i32)-> {
  let tmp = y;
  y = x;
  x = tmp;
}

let main = () -> i32 {
  var x = 1;
  var y = 2;
  
  var xRef = write x;
  var yRef = write y;

  let a = xRef;

  swap(xRef, yRef);
  swap(x, y);
  
  // assert(x == 2, "x should be 2");
  // assert(y == 1, "y should be 1");
  x
}