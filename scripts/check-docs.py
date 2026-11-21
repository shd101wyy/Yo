#!/usr/bin/env python3
"""The docs gates: doc examples, links, en/zh parity.

Three checks over the user manuals (`docs/en-US`, `docs/zh-CN`) and the READMEs
(plans/backlog/AGENT_KNOWLEDGE_CONSOLIDATION.md K5; the docs plan's step 1):

  examples  Every complete-program ```yo block is run through the compiler.
            A block is a complete program when its fence is not `yo ignore`
            and its text contains `export(` or `test(` (the docs audit's
            classification), or when its fence declares `expect=E0xxx`.
            Oracle: a block with a top-level `test(` runs through `yo test`
            (`yo check` does NOT evaluate test bodies: a type error inside
            `test("..", { ... })` passes it, measured 2026-11-21 with v0.2.79);
            every other block through `yo check`. A block passes when the
            oracle succeeds, or, for ```yo expect=E0917[,E0901], when it fails
            AND reports every listed code. Fragments (no `export(`/`test(`) are
            counted, not checked: `yo fmt --check ./docs` already proves they
            parse. Identical sources (the en/zh copies) are checked once.
  links     Every relative link in docs/**, README.md and CONTRIBUTING.md
            resolves; a `#anchor` names a heading of the target page (GitHub
            slug rules, `<a id/name>` anchors included); and the BUNDLE rule:
            only docs/en-US ships in a release (`yo context --doc` prints it),
            so a link from docs/en-US to anything outside docs/en-US is dead
            there and is flagged.
  parity    docs/en-US and docs/zh-CN hold the same pages, and each page pair
            has the same number of ```yo fences and of H2 headings.
            docs/zh-CN/README.md and CONTRIBUTING.md translate the root files
            and are paired with them instead.

Usage:
  scripts/check-docs.py [--yo PATH] [--jobs N] [--changed BASE]
                        [--checks examples,links,parity] [--report-only]

  --changed BASE   examples: only blocks in Markdown files changed between BASE
                   and HEAD (`git diff BASE...HEAD`). links and parity always
                   run over the whole tree: they take seconds, and a renamed
                   heading breaks links in files the diff never touched.
  --report-only    exit 0 whatever the findings (the CI wiring until the docs
                   plan's last step makes the gates blocking).

Run from the repository root. Prints a summary (counts per check), then each
failure. Exit 1 on any finding unless --report-only.
"""
import argparse
import concurrent.futures
import hashlib
import os
import pathlib
import re
import subprocess
import sys
import tempfile
import time
import urllib.parse

ROOT = pathlib.Path(__file__).resolve().parent.parent
EN = ROOT / 'docs' / 'en-US'
ZH = ROOT / 'docs' / 'zh-CN'
# zh-CN pages that translate a root file rather than an en-US page.
ROOT_TRANSLATIONS = {'README.md': 'README.md', 'CONTRIBUTING.md': 'CONTRIBUTING.md'}
EXAMPLE_FILES_EXTRA = ['README.md', 'pack/context.md']
LINK_FILES_EXTRA = ['README.md', 'CONTRIBUTING.md']

FENCE_OPEN = re.compile(r'^(\s*)(`{3,}|~{3,})(.*)$')
PROGRAM = re.compile(r'export\(|test\(')
TOP_TEST = re.compile(r'^\s*test\(', re.M)
EXPECT = re.compile(r'^expect=((?:E\d{4})(?:,E\d{4})*)$')
ERROR_CODE = re.compile(r'error\[(E\d{4})\]')


def rel(p: pathlib.Path) -> str:
    try:
        return str(p.relative_to(ROOT))
    except ValueError:
        return str(p)


def md_files(*dirs):
    out = []
    for d in dirs:
        out += sorted(d.rglob('*.md'))
    return out


# ---------------------------------------------------------------- Markdown scan

def scan(path: pathlib.Path):
    """Split a Markdown file into fenced blocks and prose lines.

    Returns (blocks, prose): blocks are dicts (line, info, src); prose is a list
    of (line_no, text) for lines outside any fence. A fence closes on a line of
    the same character, at least as long, with nothing after it (CommonMark).
    """
    blocks, prose = [], []
    lines = path.read_text(encoding='utf-8', errors='replace').splitlines()
    i = 0
    while i < len(lines):
        m = FENCE_OPEN.match(lines[i])
        if not m or (m.group(2)[0] == '`' and '`' in m.group(3)):
            prose.append((i + 1, lines[i]))
            i += 1
            continue
        indent, fence, info = len(m.group(1)), m.group(2), m.group(3).strip()
        body, j = [], i + 1
        while j < len(lines):
            s = lines[j].strip()
            if s and s[0] == fence[0] and set(s) == {fence[0]} and len(s) >= len(fence):
                break
            # Strip the fence's own indentation (a block nested in a list item).
            ln = lines[j]
            k = 0
            while k < indent and k < len(ln) and ln[k] == ' ':
                k += 1
            body.append(ln[k:])
            j += 1
        blocks.append({'line': i + 1, 'info': info, 'src': '\n'.join(body) + '\n'})
        i = j + 1
    return blocks, prose


def yo_info(info: str):
    """(is_yo, ignore, expected_codes) for a fence info string."""
    words = info.split()
    if not words or words[0] != 'yo':
        return False, False, []
    ignore = 'ignore' in words[1:]
    expect = []
    for w in words[1:]:
        m = EXPECT.match(w)
        if m:
            expect += m.group(1).split(',')
    return True, ignore, expect


# ---------------------------------------------------------------- examples

def changed_files(base: str):
    for spec in (f'{base}...HEAD', base):   # three-dot; two-dot if no merge base
        r = subprocess.run(['git', 'diff', '--name-only', spec, '--'],
                           cwd=ROOT, capture_output=True, text=True)
        if r.returncode == 0:
            return {ROOT / f for f in r.stdout.split()}
    sys.exit(f'check-docs: cannot diff against {base!r}: {r.stderr.strip()}')


def run_block(yo: str, std: str, src: str, is_test: bool, timeout: int):
    """Run one block through its oracle in a fresh directory: (rc, output, secs)."""
    with tempfile.TemporaryDirectory(prefix='yo-doc-block-') as td:
        name = 'block.test.yo' if is_test else 'block.yo'
        (pathlib.Path(td) / name).write_text(src)
        cmd = ([yo, 'test', name, '--disable-sanitize', '--std-path', std] if is_test
               else [yo, 'check', name, '--std-path', std])
        t0 = time.time()
        try:
            r = subprocess.run(cmd, cwd=td, capture_output=True, text=True,
                               timeout=timeout)
            return r.returncode, (r.stdout or '') + (r.stderr or ''), time.time() - t0
        except subprocess.TimeoutExpired:
            return 124, f'timed out after {timeout}s', time.time() - t0


def first_error(out: str) -> str:
    for ln in out.splitlines():
        if ln.startswith('error[') or ln.startswith('error:'):
            return ln.strip()[:160]
    for ln in out.splitlines():
        if 'error' in ln.lower() or 'FAIL' in ln:
            return ln.strip()[:160]
    tail = [ln for ln in out.splitlines() if ln.strip()]
    return tail[-1].strip()[:160] if tail else '(no output)'


def check_examples(args, report):
    files = md_files(EN, ZH) + [ROOT / f for f in EXAMPLE_FILES_EXTRA if (ROOT / f).exists()]
    if args.changed:
        changed = changed_files(args.changed)
        files = [f for f in files if f in changed]
    total = ignored = fragments = 0
    programs = []                     # (file, line, src, is_test, expect)
    for f in files:
        for b in scan(f)[0]:
            is_yo, ignore, expect = yo_info(b['info'])
            if not is_yo:
                continue
            total += 1
            if ignore:
                ignored += 1
            elif expect or PROGRAM.search(b['src']):
                programs.append((f, b['line'], b['src'], bool(TOP_TEST.search(b['src'])), expect))
            else:
                fragments += 1

    unique = {}
    for p in programs:
        key = hashlib.sha256(((p[3] and 'T' or 'C') + p[2]).encode()).hexdigest()
        unique.setdefault(key, (p[2], p[3]))
    std = str(ROOT / 'std')
    results = {}
    t0 = time.time()
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.jobs) as ex:
        futs = {ex.submit(run_block, args.yo, std, src, is_test, args.timeout): key
                for key, (src, is_test) in unique.items()}
        for fu in concurrent.futures.as_completed(futs):
            results[futs[fu]] = fu.result()
            if args.progress:
                print(f'  examples: {len(results)}/{len(unique)}', file=sys.stderr)
    wall = time.time() - t0

    fails = []
    for f, line, src, is_test, expect in programs:
        key = hashlib.sha256(((is_test and 'T' or 'C') + src).encode()).hexdigest()
        rc, out, _ = results[key]
        codes = sorted(set(ERROR_CODE.findall(out)))
        oracle = 'yo test' if is_test else 'yo check'
        if expect:
            missing = [c for c in expect if c not in codes]
            if rc == 0:
                fails.append((f, line, oracle, f'expected {",".join(expect)} but it passed'))
            elif missing:
                fails.append((f, line, oracle, f'expected {",".join(expect)}, got '
                              f'{",".join(codes) or "no code"}: {first_error(out)}'))
        elif rc != 0:
            fails.append((f, line, oracle, f'{",".join(codes) or "rc=" + str(rc)}: {first_error(out)}'))

    scope = f'files changed vs {args.changed}' if args.changed else 'all files'
    report['summary'].append(
        f'examples: {len(programs)} program blocks ({len(unique)} unique) checked, '
        f'{len(fails)} failed; {fragments} fragments not checked, {ignored} `yo ignore`; '
        f'{total} ```yo blocks in {len(files)} files ({scope}); {wall:.0f}s with {args.jobs} jobs')
    report['failures'] += [f'EXAMPLE {rel(f)}:{line} [{oracle}] {msg}' for f, line, oracle, msg in fails]


# ---------------------------------------------------------------- links

INLINE_CODE = re.compile(r'(`+)(?:(?!\1).)+?\1')
INLINE_LINK = re.compile(r'!?\[(?:[^\[\]]|\[[^\]]*\])*\]\(\s*(<[^>]*>|[^\s)]+(?:\([^)]*\)[^\s)]*)*)(?:\s+"[^"]*"|\s+\'[^\']*\')?\s*\)')
REF_DEF = re.compile(r'^\s{0,3}\[[^\]]+\]:\s*(<[^>]*>|\S+)')
HTML_LINK = re.compile(r'<(?:a|img|source)\b[^>]*?\b(?:href|src|srcset)\s*=\s*"([^"]+)"', re.I)
HTML_ANCHOR = re.compile(r'<a\b[^>]*?\b(?:id|name)\s*=\s*"([^"]+)"', re.I)
HEADING = re.compile(r'^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$')


def github_slug(text: str) -> str:
    """GitHub's heading id: the rendered text, lowercased, punctuation removed,
    spaces to hyphens (github-slugger). Python's Unicode `\\w` keeps CJK."""
    t = re.sub(r'!?\[([^\]]*)\]\([^)]*\)', r'\1', text)    # links -> their text
    t = re.sub(r'<[^>]+>', '', t)                          # inline HTML
    t = t.replace('`', '')
    t = t.strip().lower()
    t = re.sub(r'[^\w\- ]', '', t)
    return t.replace(' ', '-')


_anchor_cache = {}


def anchors_of(path: pathlib.Path):
    if path not in _anchor_cache:
        seen, ids = {}, set()
        _, prose = scan(path)
        for _, line in prose:
            m = HEADING.match(line)
            if m:
                s = github_slug(m.group(2))
                n = seen.get(s, 0)
                ids.add(s if n == 0 else f'{s}-{n}')
                seen[s] = n + 1
            for a in HTML_ANCHOR.findall(line):
                ids.add(a.lower())
        _anchor_cache[path] = ids
    return _anchor_cache[path]


def links_in(path: pathlib.Path):
    for n, line in scan(path)[1]:
        text = INLINE_CODE.sub('', line)
        for m in INLINE_LINK.finditer(text):
            yield n, m.group(1)
        m = REF_DEF.match(text)
        if m:
            yield n, m.group(1)
        for h in HTML_LINK.findall(text):
            yield n, h.split()[0]


def check_links(args, report):
    files = md_files(ROOT / 'docs') + [ROOT / f for f in LINK_FILES_EXTRA if (ROOT / f).exists()]
    checked = broken = bundle = anchors = 0
    fails = []
    for f in files:
        in_en = EN in f.parents
        for n, raw in links_in(f):
            target = raw[1:-1] if raw.startswith('<') else raw
            if re.match(r'^[a-zA-Z][a-zA-Z0-9+.-]*:', target) or target.startswith('//'):
                continue                                    # external: http:, mailto:, ...
            checked += 1
            path_part, _, anchor = target.partition('#')
            path_part = urllib.parse.unquote(path_part)
            if not path_part:
                dest = f
            elif path_part.startswith('/'):
                dest = (ROOT / path_part.lstrip('/')).resolve()
            else:
                dest = (f.parent / path_part).resolve()
            if not dest.exists():
                broken += 1
                fails.append(f'LINK    {rel(f)}:{n} {raw} -> {rel(dest)} does not exist')
                continue
            if in_en and path_part and EN != dest and EN not in dest.parents:
                bundle += 1
                fails.append(f'BUNDLE  {rel(f)}:{n} {raw} -> {rel(dest)} is outside docs/en-US '
                             f'(dead in a release bundle / `yo context --doc`)')
            if anchor and dest.is_file() and dest.suffix == '.md':
                a = urllib.parse.unquote(anchor).lower()
                if a not in anchors_of(dest):
                    anchors += 1
                    fails.append(f'ANCHOR  {rel(f)}:{n} {raw} -> no heading #{anchor} in {rel(dest)}')
    report['summary'].append(
        f'links: {checked} relative links in {len(files)} files; {broken} broken, '
        f'{bundle} outside docs/en-US from docs/en-US, {anchors} unresolved anchors')
    report['failures'] += fails


# ---------------------------------------------------------------- parity

def page_counts(path: pathlib.Path):
    blocks, prose = scan(path)
    yo = sum(1 for b in blocks if yo_info(b['info'])[0])
    h2 = sum(1 for _, line in prose if re.match(r'^ {0,3}##\s', line))
    return yo, h2


def check_parity(args, report):
    en = {str(p.relative_to(EN)) for p in EN.rglob('*.md')}
    zh = {str(p.relative_to(ZH)) for p in ZH.rglob('*.md')}
    fails = []
    for p in sorted(en - zh):
        fails.append(f'PARITY  docs/en-US/{p} has no docs/zh-CN/{p}')
    pairs = [(EN / p, ZH / p) for p in sorted(en & zh)]
    for p in sorted(zh - en):
        if p in ROOT_TRANSLATIONS and (ROOT / ROOT_TRANSLATIONS[p]).exists():
            pairs.append((ROOT / ROOT_TRANSLATIONS[p], ZH / p))
        else:
            fails.append(f'PARITY  docs/zh-CN/{p} has no docs/en-US/{p}')
    for a, b in pairs:
        (ya, ha), (yb, hb) = page_counts(a), page_counts(b)
        if ya != yb:
            fails.append(f'PARITY  {rel(a)} vs {rel(b)}: ```yo blocks {ya} vs {yb}')
        if ha != hb:
            fails.append(f'PARITY  {rel(a)} vs {rel(b)}: H2 headings {ha} vs {hb}')
    report['summary'].append(
        f'parity: {len(en)} en-US pages, {len(zh)} zh-CN pages, {len(pairs)} pairs compared; '
        f'{len(fails)} differences')
    report['failures'] += fails


# ---------------------------------------------------------------- main

def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--yo', default='yo', help='yo binary (default: yo on PATH)')
    ap.add_argument('--jobs', type=int, default=max(1, min(6, (os.cpu_count() or 2) - 1)))
    ap.add_argument('--timeout', type=int, default=600, help='seconds per example')
    ap.add_argument('--changed', metavar='BASE', help='examples: only files changed vs BASE')
    ap.add_argument('--checks', default='examples,links,parity')
    ap.add_argument('--report-only', action='store_true', help='always exit 0')
    ap.add_argument('--progress', action='store_true', help='example progress on stderr')
    args = ap.parse_args()

    checks = [c.strip() for c in args.checks.split(',') if c.strip()]
    unknown = set(checks) - {'examples', 'links', 'parity'}
    if unknown:
        ap.error(f'unknown check(s): {", ".join(sorted(unknown))}')
    report = {'summary': [], 'failures': []}
    if 'examples' in checks:
        r = subprocess.run([args.yo, '--version'], capture_output=True, text=True)
        report['summary'].append(f'checker: {args.yo} ({(r.stdout or r.stderr).strip()}), std: std/')
    for name, fn in (('links', check_links), ('parity', check_parity), ('examples', check_examples)):
        if name in checks:
            fn(args, report)

    mode = 'report-only' if args.report_only else 'blocking'
    print(f'docs checks ({mode})')
    for s in report['summary']:
        print(f'  {s}')
    if report['failures']:
        print(f'\n{len(report["failures"])} finding(s):')
        for f in report['failures']:
            print(f'  {f}')
    else:
        print('\nno findings')
    return 0 if (args.report_only or not report['failures']) else 1


if __name__ == '__main__':
    sys.exit(main())
