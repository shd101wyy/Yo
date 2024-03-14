type Data: Linear;
extern "C" {
  malloc: ()=> Data;
  length: (&Data)=> i32;
}

type Holder = {
  x: &Data;
}

let test = (holder: Holder)=> {
  let {x} = holder; // Should give error
                    // as we cannot derefence a reference to Linear value
}

let main = ()=> {
  let x = malloc();
  test(Holder {x: &x});
  consume(x);
}
