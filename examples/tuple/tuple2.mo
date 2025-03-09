type MyTuple<T> = (T,);

let main = ()-> {
  let x: MyTuple<i32> = (12,);
  let y: MyTuple<_> = (13,);
  // QUESTION: Should we allow below?
  // ANSWER: Yes, `MyTuple` should be converted to `MyTuple<_>` automatically.  
  // ANSWER: No, we should be explicit. Asking user to pass `_` manually.
  // let z: MyTuple = (13,);
}