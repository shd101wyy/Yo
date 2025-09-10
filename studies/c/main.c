#include <stdio.h>
#include <stdint.h>

extern int add(int a, int b);

// String type
struct String
{
    char *data;
    int length;
    int size;
};

union MyUnion
{
    int a;
    char b;
    int *c;
};

static inline uintptr_t
_Py_ThreadId(void)
{
    // copied from mimalloc-internal.h
    uintptr_t tid;
#if defined(_MSC_VER) && defined(_M_X64)
    tid = __readgsqword(48);
#elif defined(_MSC_VER) && defined(_M_IX86)
    tid = __readfsdword(24);
#elif defined(_MSC_VER) && defined(_M_ARM64)
    tid = __getReg(18);
#elif defined(__i386__)
    __asm__("movl %%gs:0, %0" : "=r" (tid));  // 32-bit always uses GS
#elif defined(__MACH__) && defined(__x86_64__)
    __asm__("movq %%gs:0, %0" : "=r" (tid));  // x86_64 macOSX uses GS
#elif defined(__x86_64__)
    __asm__("movq %%fs:0, %0" : "=r" (tid));  // x86_64 Linux, BSD uses FS
#elif defined(__arm__)
    __asm__ ("mrc p15, 0, %0, c13, c0, 3\nbic %0, %0, #3" : "=r" (tid));
#elif defined(__aarch64__) && defined(__APPLE__)
    __asm__ ("mrs %0, tpidrro_el0" : "=r" (tid));
#elif defined(__aarch64__)
    __asm__ ("mrs %0, tpidr_el0" : "=r" (tid));
#else
  # error "define _Py_ThreadId for this platform"
#endif
  return tid;
}

int main()
{
    // struct String me;

    // printf("%d\n", sizeof(me));
    // printf("%d\n", sizeof(char *));

    // union MyUnion u;
    // u.a = 12;
    // int x = u.a;

    printf("thread id: %lu\n", _Py_ThreadId());

    return 0;
}