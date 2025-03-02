export trait Drop for Self: Type {
  drop: (self: Self)-> ();
}

export trait Clone for Self: Linear {
  clone: (self: &Self)-> Self;
}

/*
// QUESTION: What should be the parameter type here
export trait Copy<T: Free> {
  copy: (value: T)-> T;
}
*/