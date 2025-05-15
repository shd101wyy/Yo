def main:
  ()-> (), {
  (x: (a: i32, b: boolean)) = (12, true);
  a := x.a;
  b := x.1;

  Named :: struct(x: i32, y: boolean);
  p := Named(1, false);
  x := p.x;
  y := p.1;
};