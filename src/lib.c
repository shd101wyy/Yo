
// String type
struct String
{
    char *data;
    int length;
};

// Print a string to the console
void println(struct String *string)
{
    printf("%s\n", string->data);
}