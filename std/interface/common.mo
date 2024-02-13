export interface Drop<T: Type> {
  drop: (value: T)-> ();
}

export interface Clone<T: Type> {
  clone: (value: read T)-> T;
}