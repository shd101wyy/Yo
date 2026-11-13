#!/usr/bin/env python3
"""G-D, the borrow-program generator (plans/backlog/BORROW_CHECKER_COMPLETENESS.md §6 G-D;
axes from plans/backlog/OWNERSHIP_BORROWING_ORIGINS_AUDIT.md §6).

An enumerative generator over a grammar of borrow programs. Every program is rendered TWICE from one
description: a Yo program and its rustc twin. For each program the harness records

  * Yo's verdict   (`yo check`, one batched invocation per ~30 programs: the prelude is paid once),
  * rustc's verdict (`rustc --edition 2021 --emit=metadata`; optional: skipped when rustc is absent),
  * when Yo accepts: an ASan run (`yo compile --sanitize address --allocator system`, then the binary).

Classes (the first four are findings, written to tests/origins/gen-findings/ after minimization):

  UAF             Yo accepted and the binary tripped AddressSanitizer: a hole, whatever rustc says.
  ACCEPT-VS-RUST  Yo accepted, rustc rejected with a borrow-check error, ASan stayed quiet: a candidate hole
                  (the program may only be unsound in a way this one run does not execute).
  CRASH           Yo accepted, rustc accepted, and the binary failed to compile or run for another reason.
  TEMPLATE        Yo failed with a non-borrow diagnostic: a bug of this generator (or an ICE: a compiler bug).
  precision       Yo rejected, rustc accepted: an over-freeze. Counted and summarized, never a finding (the
                  corpus rows that record the design positions live in tests/origins/rust/DIVERGENCES.tsv).

Families (dimensions in FAMILIES below):
  slot   root x holder x creation site x sink x invalidating event x read position      (§6 G-D grammar)
  args   value position of a loan x a `&mut` / moved argument x callee form              (audit §6 axes 1, 2)
  valpos a holder over a local of the position that yields it                            (audit §6 axis 3)
  join   every-arm assignment, loop back edge                                            (audit §6 axis 4)

Reproduce a run with YO_GEN_SEED=<n> (printed first). Usage, from the repository root:

  YO=<yo binary> python3 -I scripts/origins-gen.py [--count N] [--budget SECONDS] [--jobs J] [--family F]
      [--known tests/origins/gen-known.tsv] [--out tests/origins/gen-findings] [--no-asan] [--no-rustc]
      [--exhaustive] [--list]

The C compiler for the ASan leg is `clang` on PATH (inside `nix develop` locally). rc: 0 = no unknown
finding, 1 = at least one finding whose signature is not in --known, 2 = usage / environment error.
Python standard library only.
"""

import argparse
import hashlib
import itertools
import os
import random
import re
import shutil
import subprocess
import sys
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor

LONG1 = "0123456789abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmnopqrstuvwxyz"
LONG2 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
BORROW_CODES_YO = {"E0901", "E0909", "E0910", "E0911", "E0912", "E0919", "E0923", "E0924", "E0922"}
# diagnostics without a code that are the language's documented walls, not generator bugs
WALL_TEXTS = ("carries an origin inside a container or a cell", "Cannot re-point")
BORROW_CODES_RS = {
    "E0499", "E0502", "E0503", "E0505", "E0506", "E0507", "E0515", "E0521", "E0597", "E0716",
    "E0382", "E0381", "E0373", "E0713", "E0594", "E0596", "E0384", "E0505", "E0510", "E0712",
}


# --------------------------------------------------------------------------------------------------
# Rendering: every description yields a (yo, rs) pair of text, built through one Builder
# --------------------------------------------------------------------------------------------------
class Builder:
    """Two parallel line lists; `emit(yo, rs)` appends to both (rs defaults to yo)."""

    def __init__(self):
        self.yo, self.rs, self.pre_yo, self.pre_rs, self.ind = [], [], [], [], 1

    def emit(self, yo, rs=None):
        rs = yo if rs is None else rs
        if yo:
            self.yo.append("  " * self.ind + yo)
        if rs:
            self.rs.append("    " * self.ind + rs)

    def pre(self, yo, rs=None):
        rs = yo if rs is None else rs
        if yo and yo not in self.pre_yo:
            self.pre_yo.append(yo)
        if rs and rs not in self.pre_rs:
            self.pre_rs.append(rs)

    def render(self, ret_unit=True):
        yo = (
            '{ String } :: import("std/string");\n{ println } :: import("std/fmt");\n'
            '{ ArrayList } :: import("std/collections/array_list");\n'
            + "\n".join(self.pre_yo)
            + "\nmain :: (fn() -> unit)({\n"
            + "\n".join(self.yo)
            + "\n  ()\n});\nexport(main);\n"
        )
        rs = (
            "#![allow(warnings)]\nuse std::rc::Rc;\n"
            + "\n".join(self.pre_rs)
            + "\nfn main() {\n"
            + "\n".join(self.rs)
            + "\n}\n"
        )
        return yo, rs


def pr(yo_expr, rs_expr):
    return (
        "println(`OUT: ${" + yo_expr + "}`);",
        'println!("OUT: {}", ' + rs_expr + ");",
    )


# --- targets: the root kinds and what a reference to them reads / what invalidates them ---------------
def _decl_int(n, k):
    return f"mut({n}) := i32({k + 7});", f"let mut {n}: i32 = {k + 7};"


def _decl_str(n, k):
    s = (LONG1, LONG2)[k % 2]
    return f'mut({n}) := String.from("{s}");', f'let mut {n} = String::from("{s}");'


def _decl_rc(n, k):
    s = (LONG1, LONG2)[k % 2]
    return (
        f'mut({n}) := Rc.new(X(s : String.from("{s}")));',
        f'let mut {n} = Rc::new(X {{ s: String::from("{s}") }});',
    )


def _decl_list(n, k):
    s = (LONG1, LONG2)[k % 2]
    return (
        f'mut({n}) := ArrayList(String).new();\n  {n}.push(String.from("{s}"));',
        f'let mut {n} = vec![String::from("{s}")];',
    )


HEAD5 = ("slice_copy(usize(0) .. usize(5))", "[0..5].to_string()")


def _rd_str(r_yo, r_rs, deref_yo, deref_rs):
    return (
        f"{r_yo}{deref_yo}.slice_copy(usize(0) .. usize(5))",
        f"{r_rs}{deref_rs}[0..5].to_string()",
    )


TARGETS = {
    # name: T (yo, rs); decl; ref(n); rd(refexpr); events
    "int": dict(
        T=("i32", "i32"), root=("i32", "i32"), decl=_decl_int, ref=lambda n: (f"&{n}", f"&{n}"),
        rd=lambda y, r: (f"{y}.*.to_string()", f"*{r}"),
        events=("write",),
        ev={"write": lambda n: (f"{n} = i32(99);", f"{n} = 99;")},
    ),
    "str": dict(
        T=("String", "String"), root=("String", "String"), decl=_decl_str, ref=lambda n: (f"&{n}", f"&{n}"),
        rd=lambda y, r: (f"{y}.*.slice_copy(usize(0) .. usize(5))", f"{r}[0..5].to_string()"),
        events=("write", "drop", "mutcall", "move"),
        ev={
            "write": lambda n: (f'{n} = String.from("{LONG2}");', f'{n} = String::from("{LONG2}");'),
            "drop": lambda n: (f"drop({n});", f"drop({n});"),
            "mutcall": lambda n: (f'{n}.push_str("{LONG2}");', f'{n}.push_str("{LONG2}");'),
            "move": lambda n: (f"m := {n};", f"let m = {n};"),
        },
    ),
    "rc": dict(
        T=("Rc(X)", "Rc<X>"), root=("Rc(X)", "Rc<X>"), decl=_decl_rc, ref=lambda n: (f"&{n}", f"&{n}"),
        rd=lambda y, r: (f"{y}.*.*.s.slice_copy(usize(0) .. usize(5))", f"{r}.s[0..5].to_string()"),
        events=("write", "drop", "move"),
        ev={
            "write": lambda n: (
                f'{n} = Rc.new(X(s : String.from("{LONG2}")));',
                f'{n} = Rc::new(X {{ s: String::from("{LONG2}") }});',
            ),
            "drop": lambda n: (f"drop({n});", f"drop({n});"),
            "move": lambda n: (f"m := {n};", f"let m = {n};"),
        },
        pre=("X :: struct(s : String);", "struct X { s: String }"),
    ),
    "rcproj": dict(
        T=("String", "String"), root=("Rc(X)", "Rc<X>"), decl=_decl_rc, ref=lambda n: (f"&{n}.*.s", f"&{n}.s"),
        rd=lambda y, r: (f"{y}.*.slice_copy(usize(0) .. usize(5))", f"{r}[0..5].to_string()"),
        events=("write", "drop", "move"),
        ev={
            "write": lambda n: (
                f'{n} = Rc.new(X(s : String.from("{LONG2}")));',
                f'{n} = Rc::new(X {{ s: String::from("{LONG2}") }});',
            ),
            "drop": lambda n: (f"drop({n});", f"drop({n});"),
            "move": lambda n: (f"m := {n};", f"let m = {n};"),
        },
        pre=("X :: struct(s : String);", "struct X { s: String }"),
    ),
    # element of a collection: reachable only through `for` (Yo has no `&xs(i)`), growth is the event
    "elem": dict(
        T=("String", "String"), root=("ArrayList(String)", "Vec<String>"), decl=_decl_list, ref=None,
        rd=lambda y, r: (f"{y}.*.slice_copy(usize(0) .. usize(5))", f"{r}[0..5].to_string()"),
        events=("mutcall", "drop", "write", "move"),
        ev={
            "mutcall": lambda n: (
                f'mut(i) := usize(0);\n  while(i < usize(64), {{ {n}.push(String.from("{LONG2}")); i = (i + usize(1)); }});',
                f'for _ in 0..64 {{ {n}.push(String::from("{LONG2}")); }}',
            ),
            "drop": lambda n: (f"drop({n});", f"drop({n});"),
            "write": lambda n: (f"{n} = ArrayList(String).new();", f"{n} = Vec::new();"),
            "move": lambda n: (f"m := {n};", f"let m = {n};"),
        },
    ),
}


# --- holders: what carries the reference ---------------------------------------------------------------
class Holder:
    name = ""
    nrefs = 1  # references one value holds

    def ty(self, T):  # (yo, rs) type of a holder over target T
        raise NotImplementedError

    def ty_p(self, T, p):  # the type spelled over origin name `p` / lifetime 'a (for `put`)
        raise NotImplementedError

    def mk(self, T, refs, origin):  # constructor from reference expressions (yo, rs) each
        raise NotImplementedError

    def refs(self, h):  # (yo, rs) reference expressions reading out of the holder named h
        raise NotImplementedError

    def pre(self, T, b):
        pass

    def ret(self, T):  # result type of a one-ref-param constructor function `mkh(a)`
        return self.ty(T)

    def read(self, tg, h, b):
        for ry, rr in self.refs(h):
            y, r = tg["rd"](ry, rr)
            b.emit(*pr(y, r))


class RefH(Holder):
    name = "ref"

    def ty(self, T): return (f"&{T[0]}", f"&{T[1]}")
    def ty_p(self, T, p): return (f"&({T[0]}, {p})", f"&'{p} {T[1]}")
    def mk(self, T, refs, origin): return refs[0]
    def refs(self, h): return [(h[0], h[1])]


class OptH(Holder):
    name = "opt"

    def ty(self, T): return (f"Option(&{T[0]})", f"Option<&{T[1]}>")
    def ty_p(self, T, p): return (f"Option(&({T[0]}, {p}))", f"Option<&'{p} {T[1]}>")
    def mk(self, T, refs, origin): return (f"Option(&{T[0]}).Some({refs[0][0]})", f"Some({refs[0][1]})")

    def read(self, tg, h, b):
        y, r = tg["rd"]("r", "r")
        py, pyr = pr(y, r)
        b.emit(f'match({h[0]}, .Some(r) => {py.rstrip(";")}, .None => println("none"));', f"if let Some(r) = {h[1]} {{ {pyr} }}")


class H1(Holder):  # the spelled-origin 1-field holder V(p)
    name = "h1"

    def pre(self, T, b):
        b.pre(
            f"V :: (fn(comptime(p) : Origin) -> comptime(Type))(struct(r : &({T[0]}, p)));",
            "struct V<'a> { r: &'a " + T[1] + " }",
        )

    def ty(self, T): return ("V(?)", "V<'_>")
    def ty_p(self, T, p): return (f"V({p})", f"V<'{p}>")
    def mk(self, T, refs, origin): return (f"V({origin})(r : {refs[0][0]})", f"V {{ r: {refs[0][1]} }}")
    def refs(self, h): return [(f"{h[0]}.r", f"{h[1]}.r")]
    def ret(self, T): return ("V(a)", "V<'a>")


class G1(Holder):  # flow-inferred generic holder G(&T)
    name = "g1"

    def pre(self, T, b):
        b.pre("G :: (fn(comptime(U) : Type) -> comptime(Type))(struct(t : U));", "struct G<U> { t: U }")

    def ty(self, T): return (f"G(&{T[0]})", f"G<&{T[1]}>")
    def ty_p(self, T, p): return (f"G(&({T[0]}, {p}))", f"G<&'{p} {T[1]}>")
    def mk(self, T, refs, origin): return (f"G(&{T[0]})(t : {refs[0][0]})", f"G {{ t: {refs[0][1]} }}")
    def refs(self, h): return [(f"{h[0]}.t", f"{h[1]}.t")]


class S2(Holder):  # two references (two roots, or one root twice)
    name = "s2"
    nrefs = 2

    def pre(self, T, b):
        b.pre("Pair :: (fn(comptime(U) : Type) -> comptime(Type))(struct(a : U, b : U));", "struct Pair<U> { a: U, b: U }")

    def ty(self, T): return (f"Pair(&{T[0]})", f"Pair<&{T[1]}>")
    def ty_p(self, T, p): return (f"Pair(&({T[0]}, {p}))", f"Pair<&'{p} {T[1]}>")

    def mk(self, T, refs, origin):
        a, b = refs[0], refs[-1]
        return (f"Pair(&{T[0]})(a : {a[0]}, b : {b[0]})", f"Pair {{ a: {a[1]}, b: {b[1]} }}")

    def refs(self, h): return [(f"{h[0]}.a", f"{h[1]}.a"), (f"{h[0]}.b", f"{h[1]}.b")]


class BoxH(Holder):
    name = "box"

    def ty(self, T): return (f"Box(&{T[0]})", f"Box<&{T[1]}>")
    def ty_p(self, T, p): return (f"Box(&({T[0]}, {p}))", f"Box<&'{p} {T[1]}>")
    def mk(self, T, refs, origin): return (f"Box(&{T[0]}).new({refs[0][0]})", f"Box::new({refs[0][1]})")
    def refs(self, h): return [(f"{h[0]}.*", f"(*{h[1]})")]


HOLDERS = {h.name: h for h in (RefH(), OptH(), H1(), G1(), S2(), BoxH())}


# --- creation sites ---------------------------------------------------------------------------------------
def ref_names(tg, names):
    return [tg["ref"](n) for n in names]


def create(d, tg, ho, b, roots, outer_z, bare=False):
    """The holder-valued expression (yo, rs) built over `roots` (a list of variable names) at creation site
    d["create"]. Helper declarations go to b.pre / b.emit before it. `outer_z` is a long-lived second root."""
    T = tg["T"]
    site = d["create"]
    refs = [(n, n) for n in roots] if bare else ref_names(tg, roots)
    origin = roots[0]
    z = tg["ref"](outer_z)
    mk = lambda rf, o=origin: ho.mk(T, rf, o)
    if site == "ctor":
        return mk(refs)
    if site == "call":
        ret = ho.ret(T)
        body_y, body_r = ho.mk(T, [("a", "a")], "a")
        b.pre(f"mkh :: (fn(a : &{T[0]}) -> {ret[0]})({body_y});", f"fn mkh<'a>(a: &'a {T[1]}) -> {ret[1]} {{ {body_r} }}")
        return (f"mkh({refs[0][0]})", f"mkh({refs[0][1]})")
    if site == "clo":
        ret = ho.ret(T)
        body_y, body_r = ho.mk(T, [("a", "a")], "a")
        b.emit(f"(mkc : Impl(Fn(a : &{T[0]}) -> {ret[0]})) = ((a : &{T[0]}) => {body_y});", "")
        b.pre("", f"fn mkc<'a>(a: &'a {T[1]}) -> {ret[1]} {{ {body_r} }}")
        return (f"mkc({refs[0][0]})", f"mkc({refs[0][1]})")
    if site in ("armc", "armm"):
        b.pre("flag :: (fn(n : i32) -> bool)(n > i32(2));", "fn flag(n: i32) -> bool { n > 2 }")
        other = mk([z], outer_z)
        mine = mk(refs)
        if site == "armc":
            b.emit("c := flag(i32(1));", "let c = flag(1);")
            return (f"cond(c => {mine[0]}, true => {other[0]})", f"if c {{ {mine[1]} }} else {{ {other[1]} }}")
        b.emit("o := Option(i32).Some(i32(1));", "let o = Some(1);")
        return (
            f"match(o, .Some(_) => {mine[0]}, .None => {other[0]})",
            f"match o {{ Some(_) => {mine[1]}, None => {other[1]} }}",
        )
    raise ValueError(site)


def setup_decls(tg, ho, b):
    T = tg["T"]
    if "pre" in tg:
        b.pre(*tg["pre"])
    ho.pre(T, b)


# --- family: slot --------------------------------------------------------------------------------------------
SLOT_DIMS = {
    "target": ["str", "int", "rc", "rcproj", "elem"],
    "holder": ["ref", "opt", "g1", "h1", "s2", "box"],
    "create": ["ctor", "call", "armc", "armm", "clo"],
    "sink": ["same", "assign", "field", "store", "capture"],
    "event": ["none", "write", "drop", "mutcall", "move", "scope_end"],
    "victim": ["x", "y"],  # which root the event hits (y exists only for s2)
    "readpos": ["after", "before"],
}


def slot_valid(d):
    tg = TARGETS[d["target"]]
    if d["event"] not in ("none", "scope_end") and d["event"] not in tg["events"]:
        return False
    if d["event"] == "scope_end" and d["sink"] == "same":
        return False
    if d["target"] == "elem":
        # reachable only through `for`: the holder is created from the element and stored in an outer slot
        if d["create"] != "ctor" or d["sink"] != "assign" or d["holder"] in ("s2", "h1"):
            return False
        if d["event"] == "scope_end":
            return False
    if d["holder"] != "s2" and d["victim"] == "y":
        return False
    if d["event"] == "none" and (d["victim"] == "y" or d["readpos"] == "before"):
        return False
    if d["holder"] == "h1" and d["create"] in ("armc", "armm", "clo"):
        return False  # the spelled origin of an arm / closure result names no single place
    if d["holder"] == "s2" and d["create"] != "ctor":
        return False  # the one-ref constructors cannot carry two roots; the single-root twin is `g1`
    if d["create"] == "clo" and d["sink"] == "capture":
        return False
    if d["sink"] == "capture" and d["create"] in ("armc", "armm"):
        return False
    if d["holder"] == "h1" and d["sink"] == "capture":
        return False
    if d["holder"] == "ref" and (d["sink"] not in ("same", "store") or d["create"] not in ("ctor", "call", "clo")):
        # a reference binding is never re-pointed to another variable and a bare `&x` is no arm value
        # (walls: "Cannot re-point", "`&x` lends a borrow: it is written as a call argument ...")
        return False
    if d["holder"] == "box" and not WALLS:
        return False  # `Box(&T)` is a wall until N2c: every program is rejected for the same reason
    return True


def gen_slot(d):
    tg, ho = TARGETS[d["target"]], HOLDERS[d["holder"]]
    T = tg["T"]
    b = Builder()
    setup_decls(tg, ho, b)
    roots = ["x", "y"] if ho.nrefs == 2 else ["x"]
    victim = d["victim"]
    inner = d["event"] == "scope_end"
    sink = d["sink"]
    hname = ("h", "h")
    b.emit(*tg["decl"]("z", 5))
    if d["target"] == "elem":
        return gen_elem(d, tg, ho, b)
    initv = ho.mk(T, [tg["ref"]("z")] * ho.nrefs, "z")
    if sink == "field":
        b.pre("W :: (fn(comptime(U) : Type) -> comptime(Type))(struct(f : U));", "struct W<U> { f: U }")
        hty_w = ho.ty(T) if ho.name != "h1" else ("V(z)", "V<'_>")
        b.emit(f"mut(w) := W({hty_w[0]})(f : {initv[0]});", f"let mut w = W {{ f: {initv[1]} }};")
        hname = ("w.f", "w.f")
    elif sink != "same" or inner:
        b.emit(f"mut(h) := {initv[0]};", f"let mut h = {initv[1]};")
    if sink == "store":
        spelled = ho.ty_p(T, "p")
        spelled_rs = ho.ty_p(T, "a")
        b.pre(
            f"put :: (fn(generic(p : Origin), dst : &mut {spelled[0]}, v : {spelled[0]}) -> unit)({{ dst.* = v; }});",
            f"fn put<'a>(dst: &mut {spelled_rs[1]}, v: {spelled_rs[1]}) {{ *dst = v; }}",
        )
    if inner:
        b.emit("{", "{")
        b.ind += 1
    # the roots
    for k, n in enumerate(roots):
        b.emit(*tg["decl"](n, k))
    cap_names = None
    if sink == "capture":
        cap_names = [f"r{n}" for n in roots]
    expr = create(d, tg, ho, b, cap_names or roots, "z", bare=bool(cap_names))
    if sink == "capture":
        caps = ", ".join(f"r{n} : {tg['ref'](n)[0]}" for n in roots)
        b.emit(f"(mut(c) : Impl(FnMut() -> unit)) = ({{ s : &mut h, {caps} }}() => {{ s.* = {expr[0]}; }});", f"let mut c = || {{ h = {create({**d, 'create': d['create']}, tg, ho, Builder(), roots, 'z')[1]}; }};")
        stmt_sink = ("c();", "c();")
    elif sink == "same":
        stmt_sink = (f"h := {expr[0]};", f"let h = {expr[1]};")
    elif sink == "store":
        stmt_sink = (f"put(&mut h, {expr[0]});", f"put(&mut h, {expr[1]});")
    else:  # assign / field
        stmt_sink = (f"{hname[0]} = {expr[0]};", f"{hname[1]} = {expr[1]};")
    b.emit(*stmt_sink)
    vn = roots[0] if victim == "x" else roots[-1]
    if d["readpos"] == "before":
        ho.read(tg, hname, b)
    if d["event"] not in ("none", "scope_end"):
        ey, er = tg["ev"][d["event"]](vn)
        for ly, lr in zip(ey.split("\n  "), er.split("\n    ")):
            b.emit(ly, lr)
    if inner:
        b.ind -= 1
        b.emit("};", "}")
    if d["readpos"] == "after":
        ho.read(tg, hname, b)
    return b.render()


def gen_elem(d, tg, ho, b):
    """The `for` creation site: the element reference is stored into an outer slot, then the collection is hit."""
    T = tg["T"]
    b.emit(*tg["decl"]("xs", 0))
    if ho.name == "opt":
        b.emit("mut(h) := Option(&String).None;", "let mut h = None;")
    else:
        # the other holders have no empty value: seed the slot from a second long-lived list's loan
        b.emit(*tg["decl"]("w0", 1))
        seed = ho.mk(T, [("&w0", "&w0")], "w0")
        b.emit(f"mut(h) := {seed[0]};", f"let mut h = {seed[1]};")
    mkv = ho.mk(T, [("e", "e")], "e")
    b.emit(f"for(&xs, e => {{ h = {mkv[0]}; }});", f"for e in &xs {{ h = {mkv[1]}; }}")
    if d["readpos"] == "before":
        ho.read(tg, ("h", "h"), b)
    if d["event"] != "none":
        ey, er = tg["ev"][d["event"]]("xs")
        for ly, lr in zip(ey.split("\n  "), er.split("\n    ")):
            b.emit(ly, lr)
    if d["readpos"] == "after":
        ho.read(tg, ("h", "h"), b)
    return b.render()


# --- family: args ---------------------------------------------------------------------------------------------
ARGS_DIMS = {
    "value": ["lend", "named", "holder", "callres", "ctor"],
    "other": ["mutlend", "moved", "shared", "mutother"],
    "callee": ["direct", "method", "closure", "fnptr"],
    "order": ["first", "second"],
}


def args_valid(d):
    # the method form is `x.m(v)`: the receiver is the `&mut` argument, so only one `other` and order exist
    return d["callee"] != "method" or (d["other"] == "mutlend" and d["order"] == "first")


def gen_args(d):
    if d["callee"] == "method":
        return gen_args_method(d)
    b = Builder()
    value, other, callee, order = d["value"], d["other"], d["callee"], d["order"]
    T = ("String", "String")
    tg = TARGETS["str"]
    b.emit(*tg["decl"]("x", 0))
    b.emit(*tg["decl"]("w", 1))
    # the loan-carrying argument over x
    VT = ("Option(&String)", "Option<&String>")
    b.pre("id :: (fn(a : &String) -> &String)(a);", "fn id<'a>(a: &'a String) -> &'a String { a }")
    if value == "lend":
        vt, vy, vr = ("&String", "&String"), "&x", "&x"
    elif value == "named":
        b.emit("r := &x;", "let r = &x;")
        vt, vy, vr = ("&String", "&String"), "r", "r"
    elif value == "holder":
        b.emit("h := Option(&String).Some(&x);", "let h = Some(&x);")
        vt, vy, vr = VT, "h", "h"
    elif value == "callres":
        vt, vy, vr = ("&String", "&String"), "id(&x)", "id(&x)"
    else:  # ctor
        vt, vy, vr = VT, "Option(&String).Some(&x)", "Some(&x)"
    # the other argument
    if other == "mutlend":
        oy, orr, ot = "&mut x", "&mut x", ("&mut String", "&mut String")
    elif other == "moved":
        oy, orr, ot = "x", "x", ("String", "String")
    elif other == "shared":
        oy, orr, ot = "&x", "&x", ("&String", "&String")
    else:
        oy, orr, ot = "&mut w", "&mut w", ("&mut String", "&mut String")
    # the callee reads its loan argument after touching the other one
    use_y, use_r = (
        ("println(`OUT: ${v.*.slice_copy(usize(0) .. usize(5))}`);", 'println!("OUT: {}", &v[0..5]);')
        if vt[0] == "&String"
        else (
            'match(v, .Some(q) => println(`OUT: ${q.*.slice_copy(usize(0) .. usize(5))}`), .None => println("none"));',
            'if let Some(q) = v { println!("OUT: {}", &q[0..5]); }',
        )
    )
    touch_y = {
        "&mut String": 'o.push_str("zzz");',
        "String": "drop(o);",
        "&String": "_ := o.len();",
    }[ot[0]]
    touch_r = {
        "&mut String": 'o.push_str("zzz");',
        "String": "drop(o);",
        "&String": "let _ = o.len();",
    }[ot[0]]
    params_y = f"v : {vt[0]}, o : {ot[0]}" if order == "first" else f"o : {ot[0]}, v : {vt[0]}"
    params_r = f"v: {vt[1]}, o: {ot[1]}" if order == "first" else f"o: {ot[1]}, v: {vt[1]}"
    call_args_y = f"{vy}, {oy}" if order == "first" else f"{oy}, {vy}"
    call_args_r = f"{vr}, {orr}" if order == "first" else f"{orr}, {vr}"
    if callee in ("direct", "fnptr"):
        b.pre(
            f"f :: (fn({params_y}) -> unit)({{ {touch_y} {use_y} }});",
            f"fn f({params_r}) {{ {touch_r.replace('_ := ', 'let _ = ')} {use_r} }}",
        )
    if callee == "direct":
        b.emit(f"f({call_args_y});", f"f({call_args_r});")
    elif callee == "closure":
        b.emit(
            f"(g : Impl(Fn({params_y}) -> unit)) = (({params_y}) => {{ {touch_y} {use_y} }});",
            f"let g = |{params_r}| {{ {touch_r} {use_r} }};",
        )
        b.emit(f"g({call_args_y});", f"g({call_args_r});")
    elif callee == "fnptr":
        b.emit(f"(g : (fn({params_y}) -> unit)) = f;", f"let g: fn({', '.join(x.split(': ', 1)[1] for x in params_r.split(', '))}) = f;")
        b.emit(f"g({call_args_y});", f"g({call_args_r});")
    return b.render()


def gen_args_method(d):
    """x.m(v) where v borrows x.s: the receiver `&mut x` beside a loan of its own field."""
    b = Builder()
    value = d["value"]
    b.pre("Own :: struct(s : String);", "struct Own { s: String }")
    if value in ("lend", "named", "callres"):
        vt = ("&String", "&String")
    else:
        vt = ("Option(&String)", "Option<&String>")
    use_y, use_r = (
        ("println(`OUT: ${v.*.slice_copy(usize(0) .. usize(5))}`);", 'println!("OUT: {}", &v[0..5]);')
        if vt[0] == "&String"
        else (
            'match(v, .Some(q) => println(`OUT: ${q.*.slice_copy(usize(0) .. usize(5))}`), .None => println("none"));',
            'if let Some(q) = v { println!("OUT: {}", &q[0..5]); }',
        )
    )
    b.pre(
        f"impl(Own, m : (fn(self : &mut Self, v : {vt[0]}) -> unit)({{ self.s.push_str(\"zzz\"); {use_y} }}));",
        f"impl Own {{ fn m(&mut self, v: {vt[1]}) {{ self.s.push_str(\"zzz\"); {use_r} }} }}",
    )
    b.pre("id :: (fn(a : &String) -> &String)(a);", "fn id<'a>(a: &'a String) -> &'a String { a }")
    b.emit(f'mut(x) := Own(s : String.from("{LONG1}"));', f'let mut x = Own {{ s: String::from("{LONG1}") }};')
    if value == "lend":
        vy = vr = "&x.s"
    elif value == "named":
        b.emit("r := &x.s;", "let r = &x.s;")
        vy = vr = "r"
    elif value == "holder":
        b.emit("h := Option(&String).Some(&x.s);", "let h = Some(&x.s);")
        vy = vr = "h"
    elif value == "callres":
        vy = vr = "id(&x.s)"
    else:
        vy, vr = "Option(&String).Some(&x.s)", "Some(&x.s)"
    b.emit(f"x.m({vy});", f"x.m({vr});")
    return b.render()


# --- family: valpos ---------------------------------------------------------------------------------------------
VALPOS_DIMS = {
    "target": ["str", "int", "rc", "rcproj"],
    "holder": ["opt", "g1", "box"],
    "position": ["blocktail", "condarm", "matcharm", "armbind", "scrutinee"],
    "readpos": ["after", "inside"],
}


def valpos_valid(d):
    if d["holder"] == "box" and not WALLS:
        return False
    # a Copy binding is a copy; the arm-binding positions need an owned root
    return not (d["position"] in ("armbind", "scrutinee") and d["target"] == "int")


def gen_valpos(d):
    tg, ho = TARGETS[d["target"]], HOLDERS[d["holder"]]
    T = tg["T"]
    b = Builder()
    setup_decls(tg, ho, b)
    b.pre("flag :: (fn(n : i32) -> bool)(n > i32(2));", "fn flag(n: i32) -> bool { n > 2 }")
    b.emit(*tg["decl"]("z", 5))
    z = tg["ref"]("z")
    other = ho.mk(T, [z] * 1, "z")
    pos = d["position"]
    inside = d["readpos"] == "inside"

    def local_and_value(name):
        decl = tg["decl"](name, 0)
        hv = ho.mk(T, [tg["ref"](name)], name)
        return decl, hv

    hty = ho.ty(T)
    if pos in ("blocktail", "condarm", "matcharm"):
        decl, hv = local_and_value("t")
        if inside:
            blk_y = f"{{ {decl[0]} hh := {hv[0]}; {_read_inline(tg, ho, 'hh', 0)} }}"
            blk_r = f"{{ {decl[1]} let hh = {hv[1]}; {_read_inline(tg, ho, 'hh', 1)} }}"
            if pos == "blocktail":
                b.emit(f"_u := {blk_y};", f"let _u = {blk_r};")
            else:
                b.emit("c := flag(i32(1));", "let c = flag(1);")
                b.emit(f"_u := cond(c => {blk_y}, true => ());", f"let _u = if c {blk_r} else {{ () }};")
            return b.render()
        if pos == "blocktail":
            b.emit(f"h := {{ {decl[0]} {hv[0]} }};", f"let h = {{ {decl[1]} {hv[1]} }};")
        elif pos == "condarm":
            b.emit("c := flag(i32(1));", "let c = flag(1);")
            b.emit(
                f"h := cond(c => {{ {decl[0]} {hv[0]} }}, true => {other[0]});",
                f"let h = if c {{ {decl[1]} {hv[1]} }} else {{ {other[1]} }};",
            )
        else:
            b.emit("o := Option(i32).Some(i32(1));", "let o = Some(1);")
            b.emit(
                f"h := match(o, .Some(_) => {{ {decl[0]} {hv[0]} }}, .None => {other[0]});",
                f"let h = match o {{ Some(_) => {{ {decl[1]} {hv[1]} }}, None => {other[1]} }};",
            )
        ho.read(tg, ("h", "h"), b)
        return b.render()
    # armbind: an owned binding of an arm; scrutinee: a holder over the arm binding of a temporary scrutinee
    root_y, root_r = tg["decl"]("t", 0)
    root_y = root_y.replace("mut(t) := ", "").rstrip(";")
    root_r = re.sub(r"^let mut t(: i32)? = ", "", root_r).rstrip(";")
    hv = ho.mk(T, [tg["ref"]("bnd")], "bnd")
    if pos == "armbind":
        initv = ho.mk(T, [z], "z")
        b.emit(f"mut(h) := {initv[0]};", f"let mut h = {initv[1]};")
        if inside:
            ry, rr = _read_inline(tg, ho, "hh", 0), _read_inline(tg, ho, "hh", 1)
            b.emit(
                f"match(Option({tg['root'][0]}).Some({root_y}), .Some(bnd) => {{ hh := {hv[0]}; {ry} }}, .None => ());",
                f"match Some({root_r}) {{ Some(bnd) => {{ let hh = {hv[1]}; {rr} }}, None => () }};",
            )
            return b.render()
        b.emit(
            f"match(Option({tg['root'][0]}).Some({root_y}), .Some(bnd) => {{ h = {hv[0]}; }}, .None => ());",
            f"match Some({root_r}) {{ Some(bnd) => {{ h = {hv[1]}; }}, None => () }};",
        )
    else:  # scrutinee
        if inside:
            return gen_valpos({**d, "position": "blocktail"})
        b.emit(
            f"h := match(Option({tg['root'][0]}).Some({root_y}), .Some(bnd) => {hv[0]}, .None => {other[0]});",
            f"let h = match Some({root_r}) {{ Some(bnd) => {hv[1]}, None => {other[1]} }};",
        )
    ho.read(tg, ("h", "h"), b)
    return b.render()


def _read_inline(tg, ho, h, which):
    bb = Builder()
    bb.ind = 0
    ho.read(tg, (h, h), bb)
    lines = bb.yo if which == 0 else bb.rs
    return " ".join(x.strip() for x in lines)


# --- family: join -----------------------------------------------------------------------------------------------
JOIN_DIMS = {
    "target": ["str", "int", "rc"],
    "holder": ["opt", "g1"],
    "shape": ["arms_first", "arms_last", "arms_none", "loop_top", "loop_bottom", "loop_pre"],
}


def join_valid(d):
    return True


def gen_join(d):
    tg, ho = TARGETS[d["target"]], HOLDERS[d["holder"]]
    T = tg["T"]
    shape = d["shape"]
    b = Builder()
    setup_decls(tg, ho, b)
    b.pre("flag :: (fn(n : i32) -> bool)(n > i32(2));", "fn flag(n: i32) -> bool { n > 2 }")
    b.emit(*tg["decl"]("z", 5))
    b.emit(*tg["decl"]("x", 0))
    b.emit(*tg["decl"]("y", 1))
    z = tg["ref"]("z")
    initv = ho.mk(T, [z], "z")
    b.emit(f"mut(h) := {initv[0]};", f"let mut h = {initv[1]};")
    if shape.startswith("arms"):
        hx, hy = ho.mk(T, [tg["ref"]("x")], "x"), ho.mk(T, [tg["ref"]("y")], "y")
        b.emit("c := flag(i32(1));", "let c = flag(1);")
        b.emit(
            f"cond(c => {{ h = {hx[0]}; }}, true => {{ h = {hy[0]}; }});",
            f"if c {{ h = {hx[1]}; }} else {{ h = {hy[1]}; }}",
        )
        if shape != "arms_none":
            vn = "x" if shape == "arms_first" else "y"
            ey, er = tg["ev"]["write"](vn)
            b.emit(ey, er)
        ho.read(tg, ("h", "h"), b)
        return b.render()
    hx = ho.mk(T, [tg["ref"]("x")], "x")
    ey, er = tg["ev"]["write"]("x")
    b.emit("mut(i) := i32(0);", "let mut i = 0;")
    bb = Builder()
    bb.ind = 0
    ho.read(tg, ("h", "h"), bb)
    ry, rr = " ".join(s.strip() for s in bb.yo), " ".join(s.strip() for s in bb.rs)
    if shape == "loop_top":  # read the previous iteration's loan, then write the root, then re-lend it
        body_y = f"{ry} {ey} h = {hx[0]};"
        body_r = f"{rr} {er} h = {hx[1]};"
    elif shape == "loop_bottom":  # write, re-lend, then read: the old loan is dead at the write
        body_y = f"{ey} h = {hx[0]}; {ry}"
        body_r = f"{er} h = {hx[1]}; {rr}"
    else:  # loop_pre: lend before the write; the read after the loop sees the lend from the last pass
        body_y = f"h = {hx[0]}; {ey}"
        body_r = f"h = {hx[1]}; {er}"
    b.emit(
        f"while(i < i32(2), {{ {body_y} i = (i + i32(1)); }});",
        f"while i < 2 {{ {body_r} i += 1; }}",
    )
    if shape == "loop_pre":
        ho.read(tg, ("h", "h"), b)
    return b.render()


FAMILIES = {
    "slot": (SLOT_DIMS, slot_valid, gen_slot),
    "args": (ARGS_DIMS, args_valid, gen_args),
    "valpos": (VALPOS_DIMS, valpos_valid, gen_valpos),
    "join": (JOIN_DIMS, join_valid, gen_join),
}
BASE = {fam: {k: v[0] for k, v in dims.items()} for fam, (dims, _, _) in FAMILIES.items()}
BASE["slot"].update(event="none", create="ctor", sink="same", holder="ref", target="int", readpos="after")


def all_programs(family):
    dims, valid, gen = FAMILIES[family]
    keys = list(dims)
    for vals in itertools.product(*(dims[k] for k in keys)):
        d = dict(zip(keys, vals))
        if valid(d):
            yield d


def sig(family, d):
    return family + ":" + "/".join(d[k] for k in FAMILIES[family][0])


def pid(family, d):
    return family + "-" + hashlib.sha1(sig(family, d).encode()).hexdigest()[:8]


def simplifications(family, d):
    """One dimension at a time set to its base value (the minimizer's moves)."""
    dims, valid, _ = FAMILIES[family]
    out = []
    for k in dims:
        for alt in (BASE[family][k], dims[k][0]):
            if d[k] != alt:
                e = dict(d, **{k: alt})
                if valid(e) and e not in out:
                    out.append(e)
    return out


# --------------------------------------------------------------------------------------------------
# Verdicts
# --------------------------------------------------------------------------------------------------
WALLS = False  # --walls: also generate programs the language rejects by a documented wall (Box(&T))


class Env:
    yo = "yo"
    std = "std"
    cc = None
    rustc = None
    jobs = 4
    deadline = float("inf")
    controls = 8
    seed = 0


def run(cmd, timeout=900, env=None):
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, env=env)
        return p.returncode, p.stdout + p.stderr
    except subprocess.TimeoutExpired:
        return 124, "timeout"


def parse_check(out, names):
    """name -> ('OK',) | ('ERR', code, first message line). Missing names are absent."""
    res = {}
    for m in re.finditer(r"check: (\S+?\.yo) — evaluator OK", out):
        res[os.path.basename(m.group(1))] = ("OK",)
    lines = out.split("\n")
    for i, ln in enumerate(lines):
        m = re.match(r"error(?:\[(E\d+)\])?: (.*)", ln)
        if not m:
            continue
        for j in range(i + 1, min(i + 8, len(lines))):
            w = re.match(r"\s*--> (\S+?):\d+:\d+", lines[j])
            if w:
                name = os.path.basename(w.group(1))
                if name not in res:
                    res[name] = ("ERR", m.group(1) or "-", m.group(2)[:140])
                break
    return {n: res[n] for n in names if n in res}


def yo_check_batch(paths):
    d = tempfile.mkdtemp(prefix="og-chk-")
    try:
        for p in paths:
            shutil.copy(p, d)
        names = [os.path.basename(p) for p in paths]
        rc, out = run([Env.yo, "check", d, "--std-path", Env.std], timeout=1500)
        res = parse_check(out, names)
        return res, rc, out
    finally:
        shutil.rmtree(d, ignore_errors=True)


def yo_check_all(paths, log=None):
    """Batched, parallel; programs without a verdict (a crash kills a batch) are retried one by one."""
    batches = [paths[i : i + 30] for i in range(0, len(paths), 30)]
    verdicts = {}
    with ThreadPoolExecutor(Env.jobs) as ex:
        for (res, rc, out), batch in zip(ex.map(yo_check_batch, batches), batches):
            verdicts.update(res)
            missing = [p for p in batch if os.path.basename(p) not in res]
            if missing and log:
                log(f"  batch rc={rc} left {len(missing)} programs without a verdict; retrying alone")
            for p in missing:
                r1, rc1, out1 = yo_check_batch([p])
                verdicts[os.path.basename(p)] = r1.get(os.path.basename(p), ("CRASH", rc1, out1.strip().split("\n")[-1][:140]))
    return verdicts


def rustc_verdict(path):
    if not Env.rustc:
        return ("SKIP",)
    outdir = tempfile.mkdtemp(prefix="og-rs-")
    try:
        rc, out = run([Env.rustc, "--edition", "2021", "--emit=metadata", "--crate-type", "bin", "--out-dir", outdir, path], timeout=120)
    finally:
        shutil.rmtree(outdir, ignore_errors=True)
    if rc == 0:
        return ("OK",)
    codes = set(re.findall(r"error\[(E\d+)\]", out))
    if codes & BORROW_CODES_RS or "lifetime may not live long enough" in out:
        return ("ERR", sorted(codes & BORROW_CODES_RS)[0] if codes & BORROW_CODES_RS else "lifetime")
    return ("TEMPLATE", sorted(codes)[0] if codes else "-", out.strip().split("\n")[0][:120])


def asan(path):
    """('CLEAN',) | ('ASAN', kind) | ('FAIL', what)."""
    if not Env.cc:
        return ("SKIP",)
    tmp = tempfile.mkdtemp(prefix="og-asan-")
    try:
        binp = os.path.join(tmp, "prog")
        rc, out = run(
            [Env.yo, "compile", path, "--std-path", Env.std, "--optimize", "1", "--sanitize", "address",
             "--allocator", "system", "--cc", Env.cc, "-o", binp],
            timeout=600,
        )
        if rc != 0:
            return ("FAIL", "compile: " + (out.strip().split("\n")[-1][:120]))
        env = dict(os.environ, ASAN_OPTIONS="detect_stack_use_after_return=1:detect_leaks=0")
        rc, out = run([binp], timeout=60, env=env)
        m = re.search(r"ERROR: AddressSanitizer: ([\w-]+)", out)
        if m:
            return ("ASAN", m.group(1))
        if rc != 0:
            return ("FAIL", f"run rc={rc}: " + out.strip().split("\n")[-1][:100])
        return ("CLEAN",)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def classify(yo, rs, asn):
    """The class of one program from its three verdicts."""
    if yo[0] == "OK":
        if asn and asn[0] == "ASAN":
            return "UAF"
        if rs[0] == "ERR":
            return "ACCEPT-VS-RUST"
        if asn and asn[0] == "FAIL":
            return "CRASH"
        return "ok"
    if yo[0] == "ERR":
        if yo[1] == "-" and any(w in yo[2] for w in WALL_TEXTS):
            return "wall"
        if yo[1] in BORROW_CODES_YO:
            return "precision" if rs[0] == "OK" else "ok"
        return "TEMPLATE"
    return "TEMPLATE"


# --------------------------------------------------------------------------------------------------
# The run
# --------------------------------------------------------------------------------------------------
def write_progs(items, root):
    """items: [(family, dims)] -> [(id, family, dims, yo_path, rs_path)]."""
    out = []
    for fam, d in items:
        i = pid(fam, d)
        y, r = FAMILIES[fam][2](d)
        yp, rp = os.path.join(root, i + ".yo"), os.path.join(root, i + ".rs")
        with open(yp, "w") as f:
            f.write(y)
        with open(rp, "w") as f:
            f.write(r)
        out.append((i, fam, d, yp, rp))
    return out


def evaluate(progs, use_asan, log):
    yos = yo_check_all([p[3] for p in progs], log)
    with ThreadPoolExecutor(Env.jobs) as ex:
        rss = list(ex.map(rustc_verdict, [p[4] for p in progs]))
    rows = []
    for (i, fam, d, yp, rp), rs in zip(progs, rss):
        yo = yos.get(os.path.basename(yp), ("CRASH", 0, "no verdict"))
        rows.append(dict(id=i, fam=fam, d=d, yp=yp, rp=rp, yo=yo, rs=rs, asan=None))
    if use_asan and Env.cc:
        # every suspect (Yo accepts, rustc rejects), then a bounded sample of the agreeing accepts: a clean
        # control that crashes is a codegen bug the checker cannot see. A deadline cuts the controls first.
        accepted = [r for r in rows if r["yo"][0] == "OK"]
        todo = [r for r in accepted if r["rs"][0] != "OK"]
        todo += random.Random(Env.seed).sample([r for r in accepted if r["rs"][0] == "OK"], min(Env.controls, len([r for r in accepted if r["rs"][0] == "OK"])))
        todo = [r for r in todo if time.time() < Env.deadline]
        with ThreadPoolExecutor(Env.jobs) as ex:
            for r, a in zip(todo, ex.map(lambda r: asan(r["yp"]) if time.time() < Env.deadline else ("SKIP",), todo)):
                r["asan"] = a
    for r in rows:
        r["cls"] = classify(r["yo"], r["rs"], r["asan"])
    return rows


def describe(r):
    yo = r["yo"][0] if r["yo"][0] == "OK" else f"{r['yo'][1]}"
    rs = r["rs"][0] if r["rs"][0] != "ERR" else r["rs"][1]
    return f"yo={'ACCEPT' if r['yo'][0] == 'OK' else yo} rustc={'ACCEPT' if rs == 'OK' else rs} asan={r['asan'][1] if r['asan'] and len(r['asan']) > 1 else (r['asan'][0] if r['asan'] else '-')}"


def minimize(row, use_asan, log, tmp_root):
    """Greedy: set one dimension at a time to its base value while the finding's class holds. The check and
    rustc verdicts filter the candidates; only a UAF finding pays for ASan runs, simplest candidate first."""
    fam, cls = row["fam"], row["cls"]
    cur = row
    for _ in range(8):
        cands = [c for c in simplifications(fam, cur["d"]) if pid(fam, c) != cur["id"]]
        if not cands or time.time() > Env.deadline:
            break
        rows = evaluate(write_progs([(fam, c) for c in cands], tmp_root), False, log)
        same = [r for r in rows if r["yo"][0] == "OK" and (r["rs"][0] == "ERR") == (cls != "CRASH")]
        same.sort(key=lambda r: sum(r["d"][k] != BASE[fam][k] for k in r["d"]))
        if cls in ("UAF", "CRASH") and use_asan and Env.cc:
            want = "ASAN" if cls == "UAF" else "FAIL"
            nxt = None
            for i in range(0, len(same), Env.jobs):
                chunk = same[i : i + Env.jobs]
                with ThreadPoolExecutor(Env.jobs) as ex:
                    for r, a in zip(chunk, ex.map(lambda r: asan(r["yp"]), chunk)):
                        r["asan"] = a
                hit = [r for r in chunk if r["asan"][0] == want]
                if hit:
                    nxt = hit[0]
                    break
                if time.time() > Env.deadline:
                    break
            same = [nxt] if nxt else []
        if not same:
            break
        cur = same[0]
        cur["cls"] = cls
    return cur


def load_known(path):
    known = {}
    if path and os.path.exists(path):
        for ln in open(path):
            if ln.strip() and not ln.startswith("#"):
                parts = ln.rstrip("\n").split("\t")
                known[parts[0]] = parts[1:]
    return known


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--count", type=int, default=240, help="programs to sample (default 240)")
    ap.add_argument("--budget", type=int, default=600, help="seconds for the whole run (default 600)")
    ap.add_argument("--jobs", type=int, default=4)
    ap.add_argument("--family", action="append", choices=list(FAMILIES))
    ap.add_argument("--known", default="tests/origins/gen-known.tsv")
    ap.add_argument("--out", default="tests/origins/gen-findings")
    ap.add_argument("--yo", default=os.environ.get("YO", "yo"))
    ap.add_argument("--std-path", default="std")
    ap.add_argument("--no-asan", action="store_true")
    ap.add_argument("--no-rustc", action="store_true")
    ap.add_argument("--exhaustive", action="store_true", help="every valid program of the chosen families")
    ap.add_argument("--list", action="store_true", help="print the sampled programs' dimensions and exit")
    ap.add_argument("--max-minimize", type=int, default=10)
    ap.add_argument("--no-minimize", action="store_true")
    ap.add_argument("--asan-controls", type=int, default=8, help="ASan runs on this many programs both Yo and rustc accept")
    ap.add_argument("--walls", action="store_true", help="also generate programs behind documented walls (Box(&T))")
    a = ap.parse_args()

    seed = int(os.environ.get("YO_GEN_SEED") or int(time.time()) % 1000000)
    rnd = random.Random(seed)
    Env.yo, Env.std, Env.jobs = a.yo, a.std_path, a.jobs
    Env.rustc = None if a.no_rustc else shutil.which("rustc")
    Env.cc = None if a.no_asan or not shutil.which("clang") else "clang"
    global WALLS
    WALLS = a.walls
    Env.deadline = time.time() + a.budget
    Env.controls, Env.seed = a.asan_controls, seed
    t0 = time.time()
    log = lambda s: print(f"[{int(time.time() - t0):4d}s] {s}", flush=True)
    log(f"YO_GEN_SEED={seed} yo={a.yo} rustc={Env.rustc or 'ABSENT (rust verdicts skipped)'} clang={shutil.which("clang") if Env.cc else None or 'ABSENT (ASan skipped)'}")

    fams = a.family or list(FAMILIES)
    pool = {f: list(all_programs(f)) for f in fams}
    log("valid programs: " + ", ".join(f"{f}={len(pool[f])}" for f in fams))
    items = []
    if a.exhaustive:
        items = [(f, d) for f in fams for d in pool[f]]
    else:
        weights = {"slot": 0.55, "args": 0.15, "valpos": 0.15, "join": 0.15}
        total = sum(weights[f] for f in fams)
        for f in fams:
            n = max(1, round(a.count * weights[f] / total))
            items += [(f, d) for d in rnd.sample(pool[f], min(n, len(pool[f])))]
    if a.list:
        for f, d in items:
            print(sig(f, d))
        return 0
    workdir = tempfile.mkdtemp(prefix="og-gen-")
    try:
        progs = write_progs(items, workdir)
        log(f"{len(progs)} programs written to {workdir}; checking")
        rows = evaluate(progs, not a.no_asan, log)
        counts = {}
        for r in rows:
            counts[r["cls"]] = counts.get(r["cls"], 0) + 1
        log("classes: " + ", ".join(f"{k}={v}" for k, v in sorted(counts.items())))
        acc = sum(r["yo"][0] == "OK" for r in rows)
        log(f"yo accepted {acc}/{len(rows)}; asan ran on {sum(1 for r in rows if r['asan'] and r['asan'][0] != 'SKIP')}")
        known = load_known(a.known)
        findings = [r for r in rows if r["cls"] in ("UAF", "ACCEPT-VS-RUST", "CRASH")]
        os.makedirs(a.out, exist_ok=True)
        seen, new, summary = set(), 0, []
        for r in sorted(findings, key=lambda r: ("UAF", "CRASH", "ACCEPT-VS-RUST").index(r["cls"])):
            if len(seen) >= a.max_minimize:
                break
            m = r if a.no_minimize else minimize(r, not a.no_asan, log, workdir)
            s = sig(m["fam"], m["d"])
            if s in seen:
                continue
            seen.add(s)
            isnew = s not in known
            new += isnew
            base = os.path.join(a.out, m["id"])
            hdr = f"// gen-finding: {m['cls']} {describe(m)}\n// signature: {s}\n// YO_GEN_SEED={seed} reproduces the run; the program is a function of its signature alone\n"
            hdr += f"// known: {' '.join(known[s])}\n" if not isnew else "// known: NEW\n"
            with open(base + ".yo", "w") as f:
                f.write(hdr + open(m["yp"]).read())
            with open(base + ".rs", "w") as f:
                f.write(hdr.replace("//", "//") + open(m["rp"]).read())
            summary.append((m["cls"], s, describe(m), "NEW" if isnew else "known", m["id"]))
            log(f"finding {m['cls']} {s} {describe(m)} [{'NEW' if isnew else 'known'}]")
        with open(os.path.join(a.out, "findings.tsv"), "w") as f:
            f.write("# class\tsignature\tverdicts\tstatus\tfile\n")
            for row in summary:
                f.write("\t".join(row) + "\n")
        prec = [r for r in rows if r["cls"] == "precision"]
        tmpl = [r for r in rows if r["cls"] == "TEMPLATE"]
        log(f"precision divergences (yo rejects, rustc accepts): {len(prec)}")
        hist = {}
        for r in prec:
            hist[(r["fam"], r["yo"][1])] = hist.get((r["fam"], r["yo"][1]), 0) + 1
        for k, v in sorted(hist.items(), key=lambda kv: -kv[1])[:8]:
            log(f"    {k[0]} {k[1]}: {v}")
        if tmpl:
            log(f"TEMPLATE failures (generator bugs or compiler ICEs): {len(tmpl)}")
            for r in tmpl[:12]:
                msg = r["yo"][2] if len(r["yo"]) > 2 else r["rs"]
                log(f"    {sig(r['fam'], r['d'])}: yo={r['yo'][1:]} rs={r['rs']} ({r['id']})")
            with open(os.path.join(a.out, "templates.tsv"), "w") as f:
                for r in tmpl:
                    f.write(f"{sig(r['fam'], r['d'])}\t{r['yo'][1:]}\t{r['rs']}\t{r['id']}\n")
        log(f"{len(summary)} distinct findings after minimization, {new} new; findings in {a.out}")
        if os.environ.get("YO_GEN_KEEP"):
            keep = os.environ["YO_GEN_KEEP"]
            shutil.copytree(workdir, keep, dirs_exist_ok=True)
        return 1 if new else 0
    finally:
        shutil.rmtree(workdir, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
