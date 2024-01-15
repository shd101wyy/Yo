let test = (x: write i32)-> {
  x = 2;
}

let add = (x: i32, y: i32)-> i32 {
  x + y
}

let main = ()-> {
  var x = 1;
  let r = read x;
  var w = write x;
  w = add(w, 1);
 
  let w2 = write x;
  w = r + 1;
}