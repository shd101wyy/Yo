type Data: Linear;
extern "C" {
  malloc: ()=> Data;
  length: (read Data)=> i32;
}

type Holder = {
  x: read Data;
}

let test = (holder: Holder)=> {
  let {x} = holder; // Should give error
                    // as we cannot derefence a reference to Linear value
}

let main = ()=> {
  let x = malloc();
  test(Holder {x: read x});
  @consume(x);
}
