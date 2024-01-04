type Data: Linear;
extern "C" {
  malloc: ()-> Data;
  consume: (x: Data)-> ();
}
type Person = {
  age: i32,
  name: Data,
}

let test = ()-> {
  let name = malloc();
  let p: Person = {
    age: 12,
    name: name,
  }
  let ref = &name; // error: `name` is already consumed by `p`
}