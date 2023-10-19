const x = 1;
const y = 2;

export { x, y };
export { z };
export { Color, Red };
export { MyType };

const z = 3;

enum Color {
  Red,
  Green,
  Blue,
}

const Red = Color.Red;

type MyType = string;

const MyType = 12;
