Complex :: struct(t: (x: i32, y: boolean));

SomeTuple :: Complex.t;
SomeTuple2 :: Complex.0;
(s: SomeTuple) = (1, true);

x := s.0;