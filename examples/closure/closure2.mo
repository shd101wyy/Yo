type Data: Linear;
extern "C" {
  malloc: ()-> Data;
  length: (x: &Data)-> i32;
}

let main = ()-> {
  // [&]()-> ();
  // The closure is Free type.
  {
    let mut x = 1;
    let closure = ()-> {
      let y = x + 1;
      y
    }
    closure();
    closure(); // Can be called multiple times
  }

  // [@]()-> (); 
  // The closure is Free type.
  {
    let mut x = 1;
    let mut closure = ()-> {
      x = 2;
    }
    closure();
    closure(); // Can be called multiple times
  }

  // [=]()-> ();
  // The closure is Linear type.
  {
    let mut x = malloc();
    let mut closure = ()-> {
      let old = (x = malloc());
      consume(old);
      consume(x);
    }
    closure(); // Can only be called once
  }
}