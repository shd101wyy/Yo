type MyI32 = i32;
type MyInt = i8 | i16 | i32;

type Coord = {x: i32, y: i32};
type AnotherCoord = Coord | {x: f32, y: f32};

type Coord3D = Coord & {z: i32};

let main = ()-> {
  let x = MyI32 12;
  let coord = Coord {x: 12, y: 13};
}