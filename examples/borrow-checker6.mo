let test = ()-> {
  let mut x = 1;
  let y = &!x;
  // let z = y; // Error: cannot assign mutable reference to a variable.  
}