type Data: Linear;
extern "C" {
  malloc: ()=> Data;
}

let useReference = (ref: &Data)=> {
  // let x = *ref;
}

let takeOwnership = (data: Data)=> {
  consume(data);
}

let test = ()=> {
  var x = malloc();

  // let ref1 = &x;
  // let ref2 = @x;

  // let y = *ref1; // Error dereferencing a reference to linear value.  
  // let old = (*ref2 = malloc());
  // consume(old);

  useReference(&x);
  useReference(@x);
  takeOwnership(x);
}
