export trait FnOnce<
  Arguments: Type,
>{
  Output: Type;
  call_once: (self, arguments: Arguments)
          => Self.Output;
}

export trait FnMut<
  Arguments: Type,
> with FnOnce<Arguments> {
  call_mut: (&mut self, arguments: Arguments)
              => Self.Output;
}

export trait Fn<
  Arguments: Type,
> with FnMut<Arguments> {
  call: (&self, arguments: Arguments)
          => Self.Output;
}