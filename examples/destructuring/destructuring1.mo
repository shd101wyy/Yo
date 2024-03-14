type Data: Linear;
extern "C" {
  malloc: ()-> Data;
  length: (x: read Data)-> i32;
}

type MyStruct = {
  a: Option<Data>,
}

let main = ()-> {
  var x = MyStruct {
    a: Some(malloc()),
  }

  {
    let takeOut = (x.a = Option<Data>.None);
    consume(takeOut);
  }
  
  consume(x);
}