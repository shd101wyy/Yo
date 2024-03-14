type Data: Linear;
extern "C" {
  malloc: ()-> Data;
  length: (x: read Data)-> i32;
}

let main = ()-> {
  // [read]()=> ();
  // The closure is Free type.
  {
    var x = 1;
    let closure = ()=> {
      let y = x + 1;
      y
    }
    closure();
    closure(); // Can be called multiple times
  }

  // [write]()=> (); 
  // The closure is Free type.
  {
    var x = 1;
    var closure = ()=> {
      x = 2;
    }
    closure();
    closure(); // Can be called multiple times
  }

  // [own]()=> ();
  // The closure is Linear type.
  {
    var x = malloc();
    var closure = ()=> {
      let old = (x = malloc());
      consume(old);
      consume(x);
    }
    closure(); // Can only be called once
  }
}