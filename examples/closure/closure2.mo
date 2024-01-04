let main = ()-> {
  let mut x = 1;

  let closure = ()=> {
    x = 2;
  }

  closure();
}