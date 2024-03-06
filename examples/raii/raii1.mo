
type Data: Linear;
extern "C" {
  malloc: ()=> Data;
}

implements Drop<Data> {
  drop: (value: Data)=> {
    @consume(value);
  }
}

let main = ()=> {
  let x = malloc();
  // let y = malloc();
  // drop(y); /// <= Automatically inserted
  // drop(x); /// <= Automatically inserted
}