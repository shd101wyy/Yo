export enum Color {
  Red,
  Green,
  Blue,
}

export enum MyOption<T> {
  None,
  Some(value: T),
}

let main = ()=> {
  let r = Color.Red;
  let x = MyOption.Some(12);
  let y = MyOption<i32>.None;
  let z = MyOption<f32>.None;
}
