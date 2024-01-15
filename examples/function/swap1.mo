let swap = (x: write i32, y: write i32)-> {
  let tmp = x;
  x = y;
  y = tmp;
}

let main = () -> {
  var x = 1;
  var y = 2;
  swap(write x, write y);
  swap(x, y);
  // assert(x == 2, "x should be 2");
  // assert(y == 1, "y should be 1");
}