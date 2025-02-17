export class Drop<Self: Type> {
  drop: (self: Self)-> ();
}

export trait Clone<Self: Linear> { // The Clone trait can only be implemented for Linear types
  clone: (self: &Self)-> Self;
}

/*
// QUESTION: What should be the parameter type here
export class Copy<T: Free> {
  copy: (value: T)-> T;
}
*/