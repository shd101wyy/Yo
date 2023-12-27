export class Id<X: Free, T: Free> {
  id: (x: T) -> T {
    x
  }
}

let main = ()-> {
  let x = id(12);
  x
}