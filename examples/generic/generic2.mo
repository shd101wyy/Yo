let id1 = <T: Type>(x: T): T -> x;

let id2: <X: Type>(x: X)-> X =
  <T: Type>(x: T): T -> x

let id3: <T: Type>(x: T)-> T = (x)-> x