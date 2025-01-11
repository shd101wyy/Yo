
type Data: Linear;
extern "C" {
  malloc: ()=> Data;
  consume: <T>(x: T)=> ();
  length: (x: &Data)=> i32;
}

type Holder = {
  data: &Data
};

let test = (holder: Holder @2, data: &Data @1)=> {
  holder.data = data;
  consume(holder);
}