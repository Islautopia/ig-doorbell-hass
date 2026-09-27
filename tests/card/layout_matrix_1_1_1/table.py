# Before/after table from before/metrics.json and after/metrics.json (run.js output).
# python tests/card/layout_matrix_1_1_1/table.py  (integration 1.1.1: + covered, 932x430, near-square stream)
import json, os
here = os.path.dirname(os.path.abspath(__file__))
def load(label):
    p = os.path.join(here, label, 'metrics.json')
    return json.load(open(p, encoding='utf-8')) if os.path.exists(p) else {}
B, A = load('before'), load('after')
TOUCH = ('phone', 'tablet')
def cell(m, key):
    if not m or 'summary' not in m: return None
    s = m['summary']
    return s
rows = []
keys = [k for k in A if k in B] or list(A)
order = ['sections', 'masonry', 'sidebar', 'sidebarside', 'panel']
sizes = ['phone_port', 'phone_land', 'phone_land_932', 'tablet_port', 'tablet_land', 'pc']
print('| view | size | stream | layout | video % of screen | buttons over picture | overflow px (card/page) | unreachable | min target |')
print('|---|---|---|---|---|---|---|---|---|')
agg = {'b_cov': 0, 'a_cov': 0, 'changed': 0, 'b_over': 0, 'a_over': 0, 'b_unr': 0, 'a_unr': 0, 'b_small': 0, 'a_small': 0, 'n': 0}
for v in order:
    for sz in sizes:
        for o in ('portrait', 'near_square', 'landscape'):
            k = f'{v}_{sz}_{o}'
            b, a = cell(B.get(k), 0), cell(A.get(k), 0)
            if not a and not b: continue
            f = lambda s, fn: fn(s) if s else '—'
            L = lambda s: s['layout'] + ('-short' if 'ig-short' in s['cls'] else '')
            lay = f"{f(b, L)} → **{f(a, L)}**"
            cov = f"{f(b, lambda s: 'yes' if s['covered'] else 'no')} → **{f(a, lambda s: 'yes' if s['covered'] else 'no')}**"
            pct = f"{f(b, lambda s: s['imgPct'])} → **{f(a, lambda s: s['imgPct'])}**"
            ov = f"{f(b, lambda s: str(max(0, s['overflowCard'])) + '/' + str(max(0, s['overflowDoc'])))} → **{f(a, lambda s: str(max(0, s['overflowCard'])) + '/' + str(max(0, s['overflowDoc'])))}**"
            un = f"{f(b, lambda s: len(s['unreachable']))} → **{f(a, lambda s: len(s['unreachable']))}**"
            tg = f"{f(b, lambda s: s['minTarget'])} → **{f(a, lambda s: s['minTarget'])}**" if sz.startswith(TOUCH) else f"{f(b, lambda s: s['minTarget'])} → {f(a, lambda s: s['minTarget'])} (mouse)"
            print(f'| {v} | {sz} | {o} | {lay} | {pct} | {cov} | {ov} | {un} | {tg} |')
            if a and b:
                agg['n'] += 1
                agg['b_cov'] += 1 if b['covered'] else 0
                agg['a_cov'] += 1 if a['covered'] else 0
                agg['changed'] += 1 if L(a) != L(b) else 0
                agg['b_over'] += 1 if (b['overflowCard'] > 0 or (b['overflowDoc'] > 0 and v not in ('sidebar', 'sidebarside'))) else 0
                agg['a_over'] += 1 if (a['overflowCard'] > 0 or (a['overflowDoc'] > 0 and v not in ('sidebar', 'sidebarside'))) else 0
                agg['b_unr'] += 1 if b['unreachable'] else 0
                agg['a_unr'] += 1 if a['unreachable'] else 0
                if sz.startswith(TOUCH):
                    agg['b_small'] += 1 if b['minTarget'] < 44 else 0
                    agg['a_small'] += 1 if a['minTarget'] < 44 else 0
print()
print(json.dumps(agg))
