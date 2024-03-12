type Data: Linear;
extern "C" {
  malloc: ()=> Data;
  length: (data: &Data)=> i32;
}

type Holder = {
  x: &Data;
}

let test = (holder: Holder)=> {
  let len = length(holder.x);
}

let main = ()=> {
  let x = malloc();
  test(Holder {x: &x});
  @consume(x);
}
