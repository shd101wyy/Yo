type Data: Linear;
extern "C" {
  malloc: ()=> Data;
}

let test = (x: read Data)=> {
  let y = x; // Should give error
}

let main = ()=> {
  let x = malloc();
  test(x);
}