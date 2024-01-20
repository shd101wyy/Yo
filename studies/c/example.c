
typedef struct
{
  int tag;
  union
  {
    struct
    {
      int value;
    } Some;
    struct
    {
    } None;
  } variant;
} Option;

typedef struct
{
  int tag;
} Color;

int main()
{
  Color color = {.tag = 0};
  Option option;
  option = (Option){.tag = 0, .variant = {.Some = {.value = 0}}};
  switch (color.tag)
  {
  case /* constant-expression */:
    /* code */
    break;
  
  default:
    break;
  }
  return 0;
}