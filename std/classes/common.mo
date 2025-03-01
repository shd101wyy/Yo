export trait Drop<Self: Type> {
  drop: (self: Self)-> ();
}

export trait Clone<Self: Linear> {
  clone: (self: &Self)-> Self;
}

/*
// QUESTION: What should be the parameter type here
export trait Copy<T: Free> {
  copy: (value: T)-> T;
}
*/