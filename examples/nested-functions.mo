let test = ()-> {
  let x = 1;
  let add = (y: i32)-> i32 {
    // x + y // error: top level function cannot access variables in the parent scope
    y
  };

  let closureAdd = (y: i32 = x)=> i32 {
    x + y
  }

  add(3);
  closureAdd(4);
}