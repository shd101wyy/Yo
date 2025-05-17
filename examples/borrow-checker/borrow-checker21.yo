type Data: Linear;
extern "C" {
  malloc: ()-> Data;
  consume: (x: Data)-> ();
}
type Person = {
  age: i32,
  name: Data,
  job: Data,
}

let test = (mut p: Person)-> Person {
  let age = p.age;
  {
    let nameRef = &!p.name;
    let oldName = (*nameRef = malloc());
    consume(oldName);
  }
  {
    let oldName = (p.name = malloc());
    consume(oldName);
  }
  {
    let oldName = (*(&!p.name) = malloc());
    consume(oldName);
  }
  p
}