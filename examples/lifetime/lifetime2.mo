type Data: Linear;
extern "C" {
  malloc: ()=> Data;
}

type Holder = {
  x: &Data
}

let test = ()=> {
  let x = malloc();
  let xRef: &Data = x;
  
  let holder = Holder {
    x: xRef
  };

  consume(x); // error: Expected `holder` to be consumed before `x`
  consume(holder);
}