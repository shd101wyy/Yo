let test = ()-> {
  var x = 1;
  let ref1 = &x; // &i32
  let ref2 = @x; // @i32
  *ref2 = 2;
}