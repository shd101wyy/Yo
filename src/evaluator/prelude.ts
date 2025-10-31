export const PreludeModule = `
// Prelude Module

/// === Arithmetic ===
Add :: (fn(compt(Rhs) : Type, compt(Output) ?= Rhs)-> compt(Module))
  module
    Output := Output,
    (+)    :  (fn(lhs: Self, rhs: Rhs)-> Output)
;
export Add;

ComptAdd :: (fn(compt(Rhs) : Type, compt(Output) ?= Rhs)-> compt(Module))
  module
    Output := Output,
    (+)    :  (fn(compt(lhs): Self, compt(rhs): Rhs)-> compt(Output))
;
export ComptAdd;

Sub :: (fn(compt(Rhs) : Type, compt(Output) ?= Rhs)-> compt(Module))
  module
    Output := Output,
    (-)    : (fn(lhs: Self, rhs: Rhs)-> Output)
;
export Sub;

ComptSub :: (fn(compt(Rhs) : Type, compt(Output) ?= Rhs)-> compt(Module))
  module
    Output := Output,
    (-)    : (fn(compt(lhs): Self, compt(rhs): Rhs)-> compt(Output))
;
export ComptSub;

Mul :: (fn(compt(Rhs) : Type, compt(Output) ?= Rhs)-> compt(Module))
  module
    Output := Output,
    (*)    : (fn(lhs: Self, rhs: Rhs)-> Output)
;
export Mul;

ComptMul :: (fn(compt(Rhs) : Type, compt(Output) ?= Rhs)-> compt(Module))
  module
    Output := Output,
    (*)    : (fn(compt(lhs): Self, compt(rhs): Rhs)-> compt(Output))
;
export ComptMul;

Div :: (fn(compt(Rhs) : Type, compt(Output) ?= Rhs)-> compt(Module))
  module
    Output := Output,
    (/)    : (fn(lhs: Self, rhs: Rhs)-> Output)
;
export Div;

ComptDiv :: (fn(compt(Rhs) : Type, compt(Output) ?= Rhs)-> compt(Module))
  module
    Output := Output,
    (/)    : (fn(compt(lhs): Self, compt(rhs): Rhs)-> compt(Output))
;
export ComptDiv;

Mod :: (fn(compt(Rhs) : Type, compt(Output) ?= Rhs)-> compt(Module))
  module
    Output := Output,
    (%)    : (fn(lhs: Self, rhs: Rhs)-> Output)
;
export Mod;

ComptMod :: (fn(compt(Rhs) : Type, compt(Output) ?= Rhs)-> compt(Module))
  module
    Output := Output,
    (%)    : (fn(compt(lhs): Self, compt(rhs): Rhs)-> Output)
;
export ComptMod;

BitLeftShift :: (fn(compt(Rhs) : Type, compt(Output) ?= Rhs)-> compt(Module))
  module
    Output := Output,
    (<<)   : (fn(lhs: Self, rhs: Rhs)-> Output)
;
export BitLeftShift;

ComptBitLeftShift :: (fn(compt(Rhs) : Type, compt(Output) ?= Rhs)-> compt(Module))
  module
    Output := Output,
    (<<)   : (fn(compt(lhs): Self, compt(rhs): Rhs)-> compt(Output))
;
export ComptBitLeftShift;

BitRightShift :: (fn(compt(Rhs) : Type, compt(Output) ?= Rhs)-> compt(Module))
  module
    Output := Output,
    (>>)   : (fn(lhs: Self, rhs: Rhs)-> Output)
;
export BitRightShift;

ComptBitRightShift :: (fn(compt(Rhs) : Type, compt(Output) ?= Rhs)-> compt(Module))
  module
    Output := Output,
    (>>)   : (fn(compt(lhs): Self, compt(rhs): Rhs)-> Output)
;
export ComptBitRightShift;

Exponentiation :: (fn(compt(Rhs) : Type, compt(Output) ?= Rhs)-> compt(Module))
  module
    Output := Output,
    (**)   : (fn(lhs: Self, rhs: Rhs)-> Output)
;
export Exponentiation;

ComptExponentiation :: (fn(compt(Rhs) : Type, compt(Output) ?= Rhs)-> compt(Module))
  module
    Output := Output,
    (**)   : (fn(compt(lhs): Self, compt(rhs): Rhs)-> compt(Output))
;
export ComptExponentiation;

Negate :: (fn(compt(Output) : Type)-> compt(Module)) 
  module
    Output := Output,
    (neg): (fn(self: Self)-> Output)
;
export Negate;

ComptNegate :: (fn(compt(Output) : Type)-> compt(Module)) 
  module
    Output := Output,
    (neg) : (fn(compt(self): Self)-> compt(Output))
;
export ComptNegate;
`;
