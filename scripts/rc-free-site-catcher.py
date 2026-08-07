#!/usr/bin/env python3
# Layout-stable free-site catcher for the ExprInfo read-after-free.
# Records a backtrace at EVERY free (no quarantine, no reuse tricks -> heap
# layout is byte-identical, so the corruption manifests exactly as in the
# uninstrumented build). In __yo_gc_mark_gray, validates s->traverse_fn via
# dladdr; on a corrupt (freed+reused) node, dumps that node's recorded free
# backtrace = the premature-free / over-release site.
import sys
import re
src = open(sys.argv[1]).read()

infra = r'''
// ===== layout-stable free-site recorder =====
#include <execinfo.h>
#include <dlfcn.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/mman.h>
#define __FR_CAP (1u<<24)
#define __FR_BTN 12
static void** __fr_key;
static void** __fr_bt;   // __FR_CAP * __FR_BTN
static unsigned char* __fr_snap;  // __FR_CAP * 128 bytes (node bytes at free time; 56-byte RC/GC header, AstExpr data at +56)
static int __fr_init_done = 0;
static void __fr_init(void){
  if(__fr_init_done) return; __fr_init_done = 1;
  // mmap (separate region) so the free-table does NOT perturb the malloc
  // heap layout -> the layout-dependent corruption still manifests identically.
  __fr_key = (void**)mmap(NULL, (size_t)__FR_CAP*sizeof(void*), PROT_READ|PROT_WRITE, MAP_ANON|MAP_PRIVATE, -1, 0);
  __fr_bt  = (void**)mmap(NULL, (size_t)__FR_CAP*__FR_BTN*sizeof(void*), PROT_READ|PROT_WRITE, MAP_ANON|MAP_PRIVATE, -1, 0);
  __fr_snap = (unsigned char*)mmap(NULL, (size_t)__FR_CAP*128, PROT_READ|PROT_WRITE, MAP_ANON|MAP_PRIVATE, -1, 0);
}
static inline unsigned __fr_h(void* p){ unsigned long long x=(unsigned long long)p; x^=x>>33; x*=0xff51afd7ed558ccdULL; x^=x>>33; return (unsigned)(x & (__FR_CAP-1)); }
static void __fr_record(void* p){
  if(!p) return; __fr_init();
  unsigned i=__fr_h(p);
  while(__fr_key[i] && __fr_key[i]!=p) i=(i+1)&(__FR_CAP-1);
  __fr_key[i]=p;
  void* bt[__FR_BTN+2]; int n=backtrace(bt,__FR_BTN+2);
  for(int k=0;k<__FR_BTN;k++) __fr_bt[(size_t)i*__FR_BTN+k]=(k+2<n)?bt[k+2]:NULL;
  for(int b=0;b<128;b++) __fr_snap[(size_t)i*128+b]=((unsigned char*)p)[b];
}
static void __fr_dump(void* p){
  if(!__fr_init_done){ fprintf(stderr,"[FR] no free table\n"); return; }
  unsigned i=__fr_h(p);
  while(__fr_key[i]){
    if(__fr_key[i]==p){
      fprintf(stderr,"[FR] most-recent free of %p at:\n", p);
      backtrace_symbols_fd(&__fr_bt[(size_t)i*__FR_BTN], __FR_BTN, 2);
      unsigned char* nb=&__fr_snap[(size_t)i*128];
      unsigned tag=*(unsigned*)&nb[56];
      unsigned long long fid=*(unsigned long long*)&nb[64];   // Atom.id / FnCall.id
      unsigned long long a2=*(unsigned long long*)&nb[72];    // Atom.token / FnCall.func
      unsigned long long a3=*(unsigned long long*)&nb[80];    // FnCall.args
      unsigned long long ftok=*(unsigned long long*)&nb[96];  // FnCall.token
      fprintf(stderr,"[FR] freed AstExpr @free: tag=%u(0=Atom,1=FnCall) id=%llu f2=0x%llx f3=0x%llx fntok=0x%llx\n", tag, fid, a2, a3, ftok);
      return;
    }
    i=(i+1)&(__FR_CAP-1);
  }
  fprintf(stderr,"[FR] %p not found in free table (never freed?)\n", p);
}
static inline void __fr_free(void* p){ __fr_record(p); free(p); }
static inline int __fr_valid_code(void* fn){
  if(!fn) return 1;               // NULL traverse_fn is legal (leaf)
  Dl_info info; return dladdr(fn, &info) != 0 && info.dli_sname != NULL;
}
static void __fr_report_corrupt(void* s){
  fprintf(stderr,"[FR] ===== CORRUPT GC NODE (read-after-free) =====\n");
  fprintf(stderr,"[FR] node %p has invalid traverse_fn (freed+reused)\n", s);
  fprintf(stderr,"[FR] GC use site:\n");
  void* bt[24]; int n=backtrace(bt,24); backtrace_symbols_fd(bt,n,2);
  __fr_dump(s);
  fprintf(stderr,"[FR] =============================================\n");
  fflush(stderr);
  abort();
}
// ===== end recorder =====
'''

# insert infra right after the aligned_alloc macro line
anchor = '#define __yo_aligned_alloc(a,sz) __yo_ts_after(aligned_alloc((a),(sz)))\n'
if anchor not in src:
    anchor = '#define __yo_aligned_alloc aligned_alloc\n'
assert anchor in src, "no aligned_alloc anchor"
src = src.replace(anchor, anchor + infra, 1)

# route __yo_free through the recorder (layout-neutral: same free, just observed)
assert '#define __yo_free free\n' in src
src = src.replace('#define __yo_free free\n', '#define __yo_free __fr_free\n', 1)

# add validity check in the FIRST __yo_gc_mark_gray (line ~17131)
mg = '''static void __yo_gc_mark_gray(__yo_ref_header_t* s) {
  if (s->gc_mark == __YO_GC_TRIAL_DELETED) return;
  s->gc_mark = __YO_GC_TRIAL_DELETED;
  if (s->traverse_fn) s->traverse_fn(s, __yo_gc_mark_gray_visitor);
}'''
mg_new = '''static void __yo_gc_mark_gray(__yo_ref_header_t* s) {
  if (!__fr_valid_code((void*)s->traverse_fn)) __fr_report_corrupt((void*)s);
  if (s->gc_mark == __YO_GC_TRIAL_DELETED) return;
  s->gc_mark = __YO_GC_TRIAL_DELETED;
  if (s->traverse_fn) s->traverse_fn(s, __yo_gc_mark_gray_visitor);
}'''
assert mg in src, "mark_gray body not found verbatim"
src = src.replace(mg, mg_new, 1)


# walk-path check: ast_expr_is_fn_call_of dereferences a FnCall's callee Atom
# token; a freed+reused callee has a NULL token. Inject a precise check (a valid
# Atom callee ALWAYS has a token, so no reuse false-positive) that dumps the
# callee's recorded free backtrace.
m = re.search(r'static inline bool yo_id_\d+\(__yo_t26\* e, __yo_str func_name, __yo_t63 arg_count\) \{\n', src)
if m:
    ins = ('  if (e && e->tag == __YO_T26_FNCALL) { __yo_t26* __fr_fb = e->data.FnCall.func;'
           ' if (__fr_fb && __fr_fb->tag == __YO_T26_ATOM && __fr_fb->data.Atom.token == NULL)'
           ' __fr_report_corrupt((void*)__fr_fb); }\n')
    src = src[:m.end()] + ins + src[m.end():]
    print("walk-path check injected")
else:
    print("WARN: ast_expr_is_fn_call_of signature not found")

open(sys.argv[2],'w').write(src)
print("instrumented ->", sys.argv[2])
