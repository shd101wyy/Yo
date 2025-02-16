export trait FnOnce<
  Arguments: Type,
> for Type 
{
  Output: Type;
  call_once: (self, arguments: Arguments)
                -> Self.Output;
}

export trait FnMut<
  Arguments: Type,
> for Free with FnOnce<Arguments>
{
  call_mut: (&mut self, arguments: Arguments)
              -> Self.Output;
}

export trait Fn<
  Arguments: Type,
> for Free with FnMut<Arguments>
{
  call: (&self, arguments: Arguments)
          -> Self.Output;
}