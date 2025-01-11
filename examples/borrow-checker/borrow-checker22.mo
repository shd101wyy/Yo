type Data: Linear;
extern "C" {
  malloc: ()=> Data;
  consume: (x: Data)=> ();
}

let returnRef = <R:Region>(ref: &<Data, R>)=> &<Data, R> {
  ref
}

let test = ()=> {
  let x = malloc();
  {
    let ref = returnRef(&x); // This should give error
  }
  consume(x);
}