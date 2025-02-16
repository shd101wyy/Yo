type Data: Linear;
extern "C" {
  malloc: ()-> Data;
  length: (x: &Data)-> i32;
}

type MyStruct = {
  a: Option<Data>,
}

let main = ()-> {
  let mut x = MyStruct {
    a: Some(malloc()),
  }

  {
    let takeOut = (x.a = Option<Data>.None);
    consume(takeOut);
  }
  
  consume(x);
}