"""Perceus reuse-ceiling census of the emitted C — CURRENT (`__yo_tN`) naming.

Sibling of live_census_t.py (plans/archive/PERCEUS_REUSE.md §0 — Phase 0, step 2).
Measures how many constructions could, at best, take over a same-type (or
same-size) cell that dies IN THE SAME FUNCTION ACTIVATION with `ref_count == 1`
— the runtime half of the reuse precondition. Every C function definition
(`yo_id_*`) gets an activation record pushed at entry and popped by a cleanup
attribute; every constructor DEFINITION records a birth and every installed
`dispose_fn` a death (dispose runs only from the last-reference free, so a
death IS a unique-at-death cell; deaths reached through the cycle collector
are skipped via `__yo_gc_collecting`). Types whose constructor installs no
dispose_fn get a synthetic one that only records the death.

Per activation, on pop:
  ceiling_same_type[T] += min(births_T, deaths_T)           -- order-insensitive: the
       evaluator may move a dead local's drop up to the construction (the plan's
       consumed-marking), so ordering inside the activation does not matter;
  ceiling_same_size[s] += min(Σ births of size s, Σ deaths of size s)   -- Phase 3's
       cross-type extension (tracked/untracked headers differ in sizeof, so this
       never pairs across them);
  strict_same_type[T] += births of T that were IMMEDIATELY preceded (no intervening
       birth of any type in this activation) by a death of T   -- what today's drop
       placement would give with no drop movement at all (a lower bound).

  ceiling_transitive[T]: as ceiling_same_type, but a callee's one excess birth of ITS
       return type is handed to the caller at return — the cell `x := f(...)` receives
       counts as born in the caller (Yo constructs nearly everything through small
       constructor-like callees such as `ArrayList.new` / `to_string`, so the
       intra-activation ceiling alone is ~0 for every list and string by construction).

Dump at exit, one line per type:  slot gross deaths ceiling strict sizeof ceiling_transitive
and one line per function:  fid gross ceiling_same_type ceiling_same_size ceiling_transitive
(`.map` next to the output: slot → __yo_tN → Yo type name; `.fmap`: fid → C name).

Usage:
  yo compile src/main.yo --emit-c --skip-c-compiler --std-path ./std --optimize 2 > /tmp/re/fresh.c
  python3 scripts/bootstrap/reuse_census_t.py /tmp/re/fresh.c /tmp/re/reuse.c /tmp/re/reuse_dump.txt
  clang -std=c11 -fno-strict-aliasing -fwrapv -w -O1 -I$(brew --prefix openssl@3)/include \
        -o /tmp/re/yo_reuse /tmp/re/reuse.c -L$(brew --prefix openssl@3)/lib -lssl -lcrypto -lm
  /tmp/re/yo_reuse check src/main.yo --std-path ./std      # writes reuse_dump.txt at exit
  python3 scripts/bootstrap/reuse_report.py /tmp/re/reuse_dump.txt /tmp/re/reuse.c
"""
import re, sys
from pathlib import Path
src_path, out_path, dump_path = sys.argv[1], sys.argv[2], sys.argv[3]
src = Path(src_path).read_text()
tyname = {}
for m in re.finditer(r"struct (__yo_t_?\d+)_struct \{ // ([^\n:]{0,160}?) : ([^\n]{0,160})", src):
    before, after = m.group(2).strip(), m.group(3).strip()
    tyname.setdefault(m.group(1), before if before else after)
slots, labels, sizes_of = {}, [], []
def slot_for(base):
    if base not in slots:
        slots[base] = len(labels); labels.append(tyname.get(base, base)); sizes_of.append(base)
    return slots[base]
disp_to_slot = {}
synth = []   # (name, slot) synthetic dispose fns for constructors that install none
ctor_pat = re.compile(r"static (__yo_t_?\d+)\* __yo_new_\1(_\w+)?\(([^)]*)\) \{(.*?)\n\}", re.S)
def ctor_repl(m):
    base, suffix, params, body = m.group(1), m.group(2) or "", m.group(3), m.group(4)
    s = slot_for(base)
    d = re.search(r"header\.dispose_fn = \(void\(\*\)\(void\*\)\)(yo_id_\d+);", body)
    if d:
        disp_to_slot[d.group(1)] = s
    else:
        name = "__yo_ev_synth_disp_%d" % s
        if not any(n == name for n, _ in synth): synth.append((name, s))
        assert body.count("obj->header.dispose_fn = NULL;") == 1, "unexpected dispose_fn form in " + base + suffix
        body = body.replace("obj->header.dispose_fn = NULL;", "obj->header.dispose_fn = %s;" % name, 1)
    return "static %s* __yo_new_%s%s(%s) {\n  __yo_ev_birth(%d);%s\n}" % (base, base, suffix, params, s, body)
src, n_ctor = ctor_pat.subn(ctor_repl, src)
# function activations: every yo_id_* DEFINITION (not prototype). Dispose fns
# are included on purpose: child deaths then land in an activation with no births.
fnames, fret = [], []
# `__yo_fs_<hash>` is the emitter's name for a specialization whose mangled
# name exceeds 160 chars (codegen/utils/index.yo) — e.g. `ArrayList(Option(Token)).new`;
# without it every such constructor wrapper's births land in its caller.
fn_pat = re.compile(r"^(static (?:inline )?[A-Za-z_0-9 \*]+? )((?:yo_id_|__yo_fs_)[A-Za-z_0-9]*)\(([^;{]*?)\) \{$", re.M)
def fn_repl(m):
    fid = len(fnames); fnames.append(m.group(2))
    rt = re.search(r"(__yo_t_?\d+)\*\s*$", m.group(1))
    fret.append(slots[rt.group(1)] if rt and rt.group(1) in slots else -1)
    return "%s%s(%s) {\n  __yo_act_t __yo_act __attribute__((cleanup(__yo_act_pop))) = __yo_act_push(%d);" % (m.group(1), m.group(2), m.group(3), fid)
src, n_fn = fn_pat.subn(fn_repl, src)
# dispose definitions: the cell's OWN death is recorded in the CALLER's activation
# (before this function's push); the decr_rc calls in its body (child deaths)
# land in the dispose's own activation, which has no births.
def disp_repl(m):
    name = m.group(2)
    if name in disp_to_slot:
        return m.group(1) + "\n  __yo_ev_death(%d);" % disp_to_slot[name] + m.group(3)
    return m.group(0)
src, n_disp = re.subn(r"(static (?:inline )?void (yo_id_\d+)\(__yo_t_?\d+\* \w+\) \{)(\n  __yo_act_t __yo_act __attribute__\(\(cleanup\(__yo_act_pop\)\)\) = __yo_act_push\(\d+\);)", disp_repl, src)
n = len(labels)
sizes_c = ", ".join("sizeof(%s)" % b for b in sizes_of)
prelude = r'''
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#define __YO_EV_MAXE 48
typedef struct { int slot; unsigned b, bin, d, strict; unsigned char pend; } __yo_ev_e;
typedef struct { int fid; int n; int overflow; __yo_ev_e e[__YO_EV_MAXE]; } __yo_act_rec;
typedef struct { int dummy; } __yo_act_t;
static _Thread_local __yo_act_rec* __yo_act_stack = NULL;
static _Thread_local size_t __yo_act_sp = 0, __yo_act_cap = 0;
static long long __yo_ev_gross[%(n)d], __yo_ev_deaths[%(n)d], __yo_ev_ceil[%(n)d], __yo_ev_strict[%(n)d], __yo_ev_ceil_tr[%(n)d];
static const int __yo_ev_ret_slot[%(nf)d] = { %(rets)s };
static long long __yo_ev_fn_gross[%(nf)d], __yo_ev_fn_ceil[%(nf)d], __yo_ev_fn_ceil_size[%(nf)d], __yo_ev_fn_ceil_tr[%(nf)d];
static long long __yo_ev_overflow_acts = 0, __yo_ev_orphan_births = 0, __yo_ev_orphan_deaths = 0;
static const size_t __yo_ev_sizes[%(n)d] = { %(sizes)s };
static __yo_ev_e* __yo_ev_entry_in(__yo_act_rec* r, int slot) {
  for (int i = 0; i < r->n; i++) if (r->e[i].slot == slot) return &r->e[i];
  if (r->n == __YO_EV_MAXE) { r->overflow = 1; return NULL; }
  __yo_ev_e* e = &r->e[r->n++]; e->slot = slot; e->b = e->bin = e->d = e->strict = 0; e->pend = 0; return e;
}
static __yo_ev_e* __yo_ev_entry(int slot) {
  if (__yo_act_sp == 0) return NULL;
  return __yo_ev_entry_in(&__yo_act_stack[__yo_act_sp - 1], slot);
}
static void __yo_ev_birth(int slot) {
  __yo_ev_gross[slot]++;
  if (__yo_act_sp == 0) { __yo_ev_orphan_births++; return; }
  __yo_act_rec* r = &__yo_act_stack[__yo_act_sp - 1];
  __yo_ev_fn_gross[r->fid]++;
  __yo_ev_e* e = __yo_ev_entry(slot);
  if (e) { e->b++; if (e->pend) e->strict++; }
  for (int i = 0; i < r->n; i++) r->e[i].pend = 0;
}
static void __yo_ev_death(int slot) {
  if (__yo_gc_collecting) return;
  __yo_ev_deaths[slot]++;
  if (__yo_act_sp == 0) { __yo_ev_orphan_deaths++; return; }
  __yo_ev_e* e = __yo_ev_entry(slot);
  if (e) { e->d++; e->pend = 1; }
}
static __yo_act_t __yo_act_push(int fid) {
  if (__yo_act_sp == __yo_act_cap) {
    __yo_act_cap = __yo_act_cap ? __yo_act_cap * 2 : 1024;
    __yo_act_stack = (__yo_act_rec*)realloc(__yo_act_stack, __yo_act_cap * sizeof(__yo_act_rec));
    if (!__yo_act_stack) abort();
  }
  __yo_act_rec* r = &__yo_act_stack[__yo_act_sp++];
  r->fid = fid; r->n = 0; r->overflow = 0;
  return (__yo_act_t){0};
}
static void __yo_act_pop(__yo_act_t* unused) {
  (void)unused;
  __yo_act_rec* r = &__yo_act_stack[--__yo_act_sp];
  if (r->overflow) __yo_ev_overflow_acts++;
  // Transitive attribution: one excess birth of the function's return type
  // is the cell it returns — hand it to the caller (a reuse token that flows
  // through a constructor-like callee, PERCEUS_REUSE.md Phase 3).
  int rs = __yo_ev_ret_slot[r->fid];
  if (rs >= 0 && __yo_act_sp > 0) {
    for (int i = 0; i < r->n; i++) if (r->e[i].slot == rs && r->e[i].b + r->e[i].bin > r->e[i].d) {
      if (r->e[i].bin > 0) r->e[i].bin--; else r->e[i].b--;
      __yo_ev_e* pe = __yo_ev_entry_in(&__yo_act_stack[__yo_act_sp - 1], rs);
      if (pe) pe->bin++;
      break;
    }
  }
  long long ceil_t = 0, ceil_s = 0, ceil_tr = 0;
  for (int i = 0; i < r->n; i++) {
    __yo_ev_e* e = &r->e[i];
    unsigned m = e->b < e->d ? e->b : e->d;
    unsigned bt = e->b + e->bin, mt = bt < e->d ? bt : e->d;
    __yo_ev_ceil[e->slot] += m; __yo_ev_strict[e->slot] += e->strict; __yo_ev_ceil_tr[e->slot] += mt; ceil_t += m; ceil_tr += mt;
  }
  for (int i = 0; i < r->n; i++) {
    size_t sz = __yo_ev_sizes[r->e[i].slot]; int first = 1;
    for (int j = 0; j < i; j++) if (__yo_ev_sizes[r->e[j].slot] == sz) { first = 0; break; }
    if (!first) continue;
    unsigned long long b = 0, d = 0;
    for (int j = i; j < r->n; j++) if (__yo_ev_sizes[r->e[j].slot] == sz) { b += r->e[j].b + r->e[j].bin; d += r->e[j].d; }
    ceil_s += b < d ? b : d;
  }
  __yo_ev_fn_ceil[r->fid] += ceil_t; __yo_ev_fn_ceil_size[r->fid] += ceil_s; __yo_ev_fn_ceil_tr[r->fid] += ceil_tr;
}
__attribute__((destructor)) static void __yo_ev_dump(void) {
  FILE* f = fopen("%(dump)s", "w"); if (!f) return;
  fprintf(f, "# overflow_acts %%lld orphan_births %%lld orphan_deaths %%lld\n", __yo_ev_overflow_acts, __yo_ev_orphan_births, __yo_ev_orphan_deaths);
  for (int i = 0; i < %(n)d; i++)
    fprintf(f, "T %%d %%lld %%lld %%lld %%lld %%zu %%lld\n", i, __yo_ev_gross[i], __yo_ev_deaths[i], __yo_ev_ceil[i], __yo_ev_strict[i], __yo_ev_sizes[i], __yo_ev_ceil_tr[i]);
  for (int i = 0; i < %(nf)d; i++)
    if (__yo_ev_fn_gross[i] || __yo_ev_fn_ceil_tr[i]) fprintf(f, "F %%d %%lld %%lld %%lld %%lld\n", i, __yo_ev_fn_gross[i], __yo_ev_fn_ceil[i], __yo_ev_fn_ceil_size[i], __yo_ev_fn_ceil_tr[i]);
  fclose(f);
}
''' % {"n": n, "nf": len(fnames), "sizes": sizes_c, "dump": dump_path, "rets": ", ".join(str(r) for r in fret)}
synth_c = "".join("static void %s(void* p) { (void)p; __yo_ev_death(%d); }\n" % (name, s) for name, s in synth)
# The hooks read __yo_gc_collecting (declared in the runtime) and sizeof every
# __yo_tN (typedefs come first), so insert them right before the first
# constructor definition; forward-declare the hooks at the top for the
# dispose/activation injections that may precede that point.
fwd = "\nstatic void __yo_ev_birth(int slot); static void __yo_ev_death(int slot);\ntypedef struct { int dummy; } __yo_act_t;\nstatic __yo_act_t __yo_act_push(int fid); static void __yo_act_pop(__yo_act_t* unused);\n"
prelude = prelude.replace("typedef struct { int dummy; } __yo_act_t;\n", "")
inc_end = src.find("\n", src.rfind("#include <", 0, src.find("typedef struct __yo_ref_header_t")))
src = src[:inc_end + 1] + fwd + src[inc_end + 1:]
first_ctor = src.find(") {\n  __yo_ev_birth("); first_ctor = src.rfind("\n\n", 0, first_ctor)
src = src[:first_ctor] + prelude + synth_c + src[first_ctor:]
Path(out_path).write_text(src)
Path(out_path + ".map").write_text("".join("%d\t%s\t%s\n" % (i, sizes_of[i], lab) for i, lab in enumerate(labels)))
Path(out_path + ".fmap").write_text("".join("%d\t%s\n" % (i, f) for i, f in enumerate(fnames)))
print("ctors:", n_ctor, "disposes matched:", n_disp, "synthetic disposes:", len(synth), "functions:", n_fn, "types:", n)
