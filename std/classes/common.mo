export class Drop<T: Type> {
  drop: (value: T)=> ();
}

export class Clone<T: Type> {
  clone: (value: *T)=> T;
}

export class Copy<T: Type> {
  copy: (value: *T)=> T;
}