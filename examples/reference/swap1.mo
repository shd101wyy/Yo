let swap = (x: @<i32>, y: @<i32>)=> {
  let a = *x;
  *x = *y;
  *y = a;
}

let main = ()=> {
  var x = 1;
  var y = 2;
  swap(@x, @y);
}