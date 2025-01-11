type Data: Linear;
extern "C" {
  malloc: ()=> Data;
  consume: (x: Data)=> ();
}


let test = (flag: boolean)=> {
  let x = malloc();
  defer consume(x);

  if (flag) {
    let ref1 = &x;
  } else {
    let ref2 = &x;
  }
}