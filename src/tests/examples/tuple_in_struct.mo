def main:
  ()-> (), {
  SomeTuple :: type (x: i32, y: boolean);
  Complex :: struct(t: SomeTuple);
  (s: SomeTuple) = (1, true);
  x := s.0;
};