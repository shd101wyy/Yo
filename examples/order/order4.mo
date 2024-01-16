
type Data: Linear;
extern "C" {
  malloc: ()-> Data;
  consume: <T>(x: T)-> ();
  length: (x: read Data)-> i32;
}

let test = (flag: boolean)-> {
  let x = malloc();
  
  var holder = {
    data: (read x)
  };
  let y = malloc();

  let z = if (flag) {
    read x
  } else {
    read x
  };

  holder.data = z;

  consume(y);
  length(holder.data)
  consume(x);

  // length(holder.data); // error: x is already consumed.  
}