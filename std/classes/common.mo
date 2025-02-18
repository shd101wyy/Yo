export trait Drop for Type {
  drop: (self: Self)-> ();
}

export trait Clone for Type {
  clone: (self: &Self)-> Self;
}

/*
// QUESTION: What should be the parameter type here
export class Copy<T: Free> {
  copy: (value: T)-> T;
}
*/