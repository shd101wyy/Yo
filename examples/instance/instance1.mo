export interface Id<T: Free> {
  id: (x: T) -> T; /* {
    x
  }*/
}

implement Id<i32> {
  id: (x: i32) -> i32 {
    x + 2
  }
}


let main = ()-> i32 {
  let x = id(12);
  x
}