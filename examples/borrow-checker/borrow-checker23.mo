let increase = <R: Region>(x: &!<i32, R>)-> {
  *x = *x + 1;
}

// https://stackoverflow.com/questions/75809087/in-rust-what-the-mechanism-of-transferring-a-mutable-reference-into-a-function
let main = ()-> {
  var x = 0;
  let xRef = &!x;
  increase(xRef);
  increase(xRef); // error: xRef is already consumed.  
}