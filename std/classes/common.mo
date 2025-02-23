export class Drop<Self: Type> {
  drop: (self: Self)-> ();
}

export class Clone<Self: Type> {
  clone: (self: &Self)-> Self;
}

/*
// QUESTION: What should be the parameter type here
export class Copy<T: Free> {
  copy: (value: T)-> T;
}
*/