type Person = .Person;

type Color = 
  | .Red
  | .Green
  | .Blue
  ;

type MyOption<T> = 
  | .Some (T,)
  | .None
  ;

type Message =
  | .Quit
  | .Move { x: i32, y: i32 }
  | .Write (i32,)
  | .ChangeColor { r: i32, g: i32, b: i32 }
  ;