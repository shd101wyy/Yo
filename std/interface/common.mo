export type Drop<T: Type> = {
  drop: (value: T)=> ();
}

export type Clone<T: Type> = {
  clone: (value: &T)=> T;
}