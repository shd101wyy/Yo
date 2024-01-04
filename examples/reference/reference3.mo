type Data: Linear;
extern "C" {
  malloc: ()-> Data;
  consume: (x: Data)-> ();
}

let length = <X:Type, P:Region>(x: &<X,P>) -> i32 {
  0
}

let compare = <R:Region>(x: &<Data, R>, y: &<Data, R>) -> boolean {
  let a = length(x);
  let b = length(y);
  true
}

let main = ()-> {
  let x = malloc();
  let y = malloc();

  {
    let xRef = &x;
    {
      let yRef = &y;
      let flag = compare(&x, &y);  // This works

      // Below will not work, because xRef and yRef
      // are not defined in the same Region.
      // let flag = compare(xRef, yRef);
    }
  }
  
  consume(y);
  consume(x);

}