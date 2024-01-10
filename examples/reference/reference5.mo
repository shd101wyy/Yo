let main = ()-> {
  let mut x = 1;
  let ref1 = &x;
  let ref2 = &!x; 
  *ref2 = 2;
}