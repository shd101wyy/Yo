type Data: Linear;
extern "C" {
  malloc: ()=> Data;
  consume: (x: Data)=> ();
}

let test = ()=> Data {
  malloc()
}