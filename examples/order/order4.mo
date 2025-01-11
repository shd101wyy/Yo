
type Data: Linear;
extern "C" {
  malloc: ()=> Data;
  consume: <T>(x: T)=> ();
  length: (x: &Data)=> i32;
}

let test = (flag: boolean)=> {
  let x = malloc();
  
  var holder = {
    data: (&x)
  };
  let y = malloc();

  let z = if (flag) {
    &x
  } else {
    &x
  };

  holder.data = z;

  consume(y);
  length(holder.data)
  consume(x);

  // length(holder.data); // error: x is already consumed.  
}