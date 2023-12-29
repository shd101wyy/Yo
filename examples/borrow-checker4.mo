extern "C" {
  // consume: <R: Region>(data: &!<i32, R>)->();
  consume: <T>(data: T)-> ();
}

let test = ()-> {
  let mut x = 1;
  {
    let ref = &!x;
  }
  {
    let ref2 = &!x;
  }
}