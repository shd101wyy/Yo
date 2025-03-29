fn FnOnce(Context: Type, Arguments: Type), interface {
  (Output: Type) = Context,
  call_once: (fn(self: Context, arguments: Arguments)
                -> this.Output)
};

fn FnMut(
  (Context: Free) <: FnOnce(_, Arguments), // _ here means Context
  Arguments: Type
), interface {
  (Output: Type) = FnOnce(Context, Arguments).Output,
  call_mut: (fn(self: &!(Context), arguments: Arguments)
                -> this.Output)
}

fn Fn(
  (Context: Free) <: FnMut(_, Arguments), // _ here means Context
  Arguments: Type
), interface {
  (Output: Type) = FnMut(Context, Arguments).Output,
  call: (fn(self: &(Context), arguments: Arguments)
           -> this.Output)
};


{ FnOnce, FnMut, Fn }