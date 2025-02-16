type I32 = &i32;

let swap = (x: @i32, y: @i32)-> {
  let tmp = *x;
  *x = *y;
  *y = tmp;
}

let useImmutableReference = (x: &i32)-> {}

let test = ()-> {
  let mut x = 1;
  let mut y = 2;

  /*
  let ref1 = &x; // &i32
  let ref2 = @x; // @i32
  let x1 = *ref1;
  let x2 = *ref2;
  *ref2 = 3;
  // *ref1 = 3; // Error
  */
  
  swap(@x, @y);
  useImmutableReference(&x);
  useImmutableReference(@x);
}