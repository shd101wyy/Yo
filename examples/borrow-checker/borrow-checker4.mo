extern "C" {
  // consume: <R: Region>(data: &!<i32, R>)->();
  consume: <T>(data: T)-> ();
}

let test = ()-> {
  var x = 1;
  {
    let ref = &!x;
    // let ref2 = ref; // allowed
    let ref3 = ref; // error: use of consumed value.  
    // let ref4 = &x;  // error: already borrowed as mutable reference.  
    // let ref5 = &!x;  // error: already borrowed as mutable reference.  
  }
  {
    let ref = &x;
    let ref2 = &x; // allowed
    let ref3 = ref; // allowed
    // let ref4 = &!x; // error: already borrowed as immutable reference.
  }
}