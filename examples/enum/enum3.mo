export enum Color {
  Red,
  Green,
  Blue,
}


let main = ()-> i32 {
  let r = Color.Red;
  let num = match (r) {
    Color.Green => 1,
    Color.Red => 2,
    _ => 3,
  };
  num
}
