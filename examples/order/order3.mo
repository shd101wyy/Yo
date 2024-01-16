
type Data: Linear;
extern "C" {
  malloc: ()-> Data;
  consume: <T>(x: T)-> ();
  length: (x: read Data)-> i32;
}

type Holder = {
  data: read Data
};

let test = (holder: Holder @2, data: read Data @1)-> {
  holder.data = data;
  consume(holder);
}