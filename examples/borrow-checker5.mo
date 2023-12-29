let test = ()-> {
  let mut x = 1;
  {
    let ref = &!x;
    x = x + 1; // error: already borrowed as mutable reference ^
  }
}