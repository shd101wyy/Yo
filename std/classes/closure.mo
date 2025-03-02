export trait FnOnce<
  Arguments: Type,
> for Context: Type {
  Output: Type;
  call_once: (self: Context, arguments: Arguments)
                -> this.Output;
}

export trait FnMut<
  Arguments: Type;
> for Context: Free impl FnOnce<Arguments>
{
  Output: Type = (FnOnce<Arguments> for Context).Output;
  call_mut: (self: &mut Context, arguments: Arguments)
              -> this.Output; 
}

export trait Fn<
  Arguments: Type
> for Context: Free impl FnMut<Arguments>,
{
  Output: Type = (FnMut<Arguments> for Context).Output;
  call: (self: &Context, arguments: Arguments)
          -> this.Output;
}