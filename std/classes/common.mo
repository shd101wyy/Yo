export trait Drop for Type {
  drop: (self)=> ();
}

export trait Clone for Linear { // The Clone trait can only be implemented for Linear types
  clone: (&self)=> Self;
}

/*
// QUESTION: What should be the parameter type here
export class Copy<T: Free> {
  copy: (value: T)=> T;
}
*/