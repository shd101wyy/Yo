type Data: Linear;
extern "C" {
  malloc: ()=> Data;
  consume: (x: Data)=> ();
}
type Person = {
  age: i32,
  name: Data,
  job: Data,
}

let test = (p: Person)=> {
  let age = p.age;
  let {name, job} = p;

  consume(name);
  consume(job);
}