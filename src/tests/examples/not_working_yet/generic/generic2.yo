let id1 = <T: Type>(x: T): T -> x;

let id2: <X: Type>(x: X)-> X =
  <T: Type>(x: T): T -> x

let id3: <T: Type>(x: T)-> T = (x)-> x

let use_id = ()-> {
  let a1 = id1<i32>(1);
  let a2 = id2<i32>(2);
  let a3 = id3<i32>(3);

  let b1 = id1<_>(1);
  let b2 = id2<_>(2);
  let b3 = id3<_>(3);

  let c1 = id1(1);
  let c2 = id2(2);
  let c3 = id3(3);

  let d1 = 1.id1();
  let d2 = 2.id2();
  let d3 = 3.id3();

  let e1 = 1.id1<i32>();
  let e2 = 2.id2<i32>();
  let e3 = 3.id3<i32>();

  let f1 = 1.id1<_>();
  let f2 = 2.id2<_>();
  let f3 = 3.id3<_>();
}