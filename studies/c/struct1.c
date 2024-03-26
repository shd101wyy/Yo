#include <stdio.h>

typedef struct Coord Coord_t;
typedef struct Holder Holder_t;

struct Coord
{
    int x;
    int y;
};

struct Holder
{
    Coord_t coord;
};

int main() {
    Coord_t coord = {1, 2};
    Holder_t holder = {coord};

    holder.coord.x = 12;
    holder.coord.y = 13;

    printf("x: %d, y: %d\n", holder.coord.x, holder.coord.y);
    printf("x: %d, y: %d\n", coord.x, coord.y);

    return 0;
}