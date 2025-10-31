export const BuiltinModuleElements = {
  // === Arithmetic ===
  Add: `{
    extern "Yo", __yo_op_add : (fn(forall(T : Type), x : T, y : T) -> T);
    impl(Self, Add(Self)
      (+): ((a, b) -> __yo_op_add(a, b))
    )
  }`,

  Sub: `{
    extern "Yo", __yo_op_sub : (fn(forall(T : Type), x : T, y : T) -> T);
    impl(Self, Sub(Self)
      (-): ((a, b) -> __yo_op_sub(a, b))
    )
  }`,

  Mul: `{
    extern "Yo", __yo_op_mul : (fn(forall(T : Type), x : T, y : T) -> T);
    impl(Self, Mul(Self)
      (*): ((a, b) -> __yo_op_mul(a, b))
    )
  }`,

  Div: `{
    extern "Yo", __yo_op_div : (fn(forall(T : Type), x : T, y : T) -> T);
    impl(Self, Div(Self)
      (/): ((a, b) -> __yo_op_div(a, b))
    )
  }`,
  Mod: `{
    extern "Yo", __yo_op_mod : (fn(forall(T : Type), x : T, y : T) -> T);
    impl(Self, Mod(Self)
      (%): ((a, b) -> __yo_op_mod(a, b))
    )
  }`,
  Negate: `{
    extern "Yo", __yo_op_neg : (fn(forall(T : Type), x : T) -> T);
    impl(Self, Negate(Self)
      (neg): ((a) -> __yo_op_neg(a))
    )
  }`,
  BitLeftShift: `{
    extern "Yo", __yo_op_bit_left_shift : (fn(forall(T : Type), x : T, y : T) -> T);
    impl(Self, BitLeftShift(Self)
      (<<): ((a, b) -> __yo_op_bit_left_shift(a, b))
    )
  }`,
  BitRightShift: `{
    extern "Yo", __yo_op_bit_right_shift : (fn(forall(T : Type), x : T, y : T) -> T);
    impl(Self, BitRightShift(Self)
      (>>): ((a, b) -> __yo_op_bit_right_shift(a, b))
    )
  }`,

  // === Logic ===
  LogicalNot: `{
    extern "Yo", __yo_op_not : (fn(forall(T : Type), x : T) -> boolean);
    impl(Self, LogicalNot
      (!): ((a) -> __yo_op_not(a))
    )
  }`,
  BitNot: `{
    extern "Yo", __yo_op_bit_complement : (fn(forall(T : Type), x : T) -> T);
    impl(Self, BitNot(Self)
      (~): ((a) -> __yo_op_bit_complement(a))
    )
  }`,
  BitAnd: `{
    extern "Yo", __yo_op_bit_and : (fn(forall(T : Type), x : T, y : T) -> T);
    impl(Self, BitAnd(Self)
      (&): ((a, b) -> __yo_op_bit_and(a, b))
    )
  }`,
  BitOr: `{
    extern "Yo", __yo_op_bit_or : (fn(forall(T : Type), x : T, y : T) -> T);
    impl(Self, BitOr(Self)
      (|): ((a, b) -> __yo_op_bit_or(a, b))
    )
  }`,
  BitXor: `{
    extern "Yo", __yo_op_bit_xor : (fn(forall(T : Type), x : T, y : T) -> T);
    impl(Self, BitXor(Self)
      (^): ((a, b) -> __yo_op_bit_xor(a, b))
    )
  }`,
};
