void print_i32(int x)
{
    // do nothing
}

struct holder
{
    int &x;
};

int main()
{
    int x = 12;
    int &x_ref = x;
    print_i32(x_ref);

    struct holder h =
    {
        x
    };
    h.x = 13;

    auto y = x_ref;
    auto z = h.x;
}