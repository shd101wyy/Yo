type I32 = &i32;

let swap = (x: @i32, y: @i32)=> {
  // let tmp = *x;
  // *x = *y;
  // *y = tmp;
}

let test = ()=> {
  var x = 1;
  let ref1 = &x; // &i32
  let ref2 = @x; // @i32
  let x1 = *ref1;
  let x2 = *ref2;
  // *ref2 = 2;
}