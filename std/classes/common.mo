export class Drop<T: Type> {
  drop: (value: T)=> ();
}

export class Clone<T: Linear> {
  clone: (value: &T)=> T;
}

/*
// QUESTION: What should be the parameter type here
export class Copy<T: Free> {
  copy: (value: T)=> T;
}
*/