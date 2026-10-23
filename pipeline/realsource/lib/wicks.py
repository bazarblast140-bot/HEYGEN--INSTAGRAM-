"""Isolated wick spikes between TradingView and Yahoo ^NSEI 5m bars.

23 Oct 2026 (held runs 39908584540, 39920316301): TradingView's 10:35 bar printed a
spike low of 22,407.05 while Yahoo (5m and 1m) showed 22,454.60; open and close of
that bar agreed. That bar was also TradingView's day low, so the carousel would have
printed a number only one feed saw.

Rules:
- A MISMATCH bar is a tolerable wick spike when its close, and its open (where the
  open is compared, i.e. not 09:15), are within TOL. Up to MAX_SPIKES such bars are
  tolerated; more, or any close/open mismatch, is a real feed mismatch and fails.
- A bar's high/low counts for the printed extremes only where both feeds agree. For a
  bar whose high (low) differs by more than TOL, the agreed value is the LESS extreme
  of the two: it lies inside both candles' ranges, so both feeds traded there
  (normally the Yahoo-confirmed value). The spike number itself is never printed.
"""
MAX_SPIKES = 2

def spike_ok(b, r, tol):
    if abs(b['c'] - r['c']) > tol: return False
    if r.get('time') != '09:15' and abs(b['o'] - r['o']) > tol: return False
    return True

def classify(bad, tol):
    """bad: MISMATCH bars (each with .yahoo). Returns (spikes, real) lists."""
    if all(spike_ok(b, b['yahoo'], tol) for b in bad) and len(bad) <= MAX_SPIKES: return list(bad), []
    return [], list(bad)

def agreed(b, tol):
    """(high, low) of bar b that both feeds agree on."""
    r = b.get('yahoo')
    if not r: return b['h'], b['l']
    h = b['h'] if abs(b['h'] - r['h']) <= tol else min(b['h'], r['h'])
    l = b['l'] if abs(b['l'] - r['l']) <= tol else max(b['l'], r['l'])
    return h, l

def extremes(tb, tol):
    """Day high/low bars and agreed prices: ((bar, price), (bar, price))."""
    hs = [(b, agreed(b, tol)[0]) for b in tb]; ls = [(b, agreed(b, tol)[1]) for b in tb]
    return max(hs, key=lambda p: p[1]), min(ls, key=lambda p: p[1])

def yahoo_extremes(yw, tvmap, tol):
    """Yahoo high/low over the same window, with the same agreed-value rule per slot."""
    def ag(r):
        b = tvmap.get(r['time'])
        return agreed(dict(b, yahoo=r), tol) if b else (r['h'], r['l'])
    hs = [(r, ag(r)[0]) for r in yw]; ls = [(r, ag(r)[1]) for r in yw]
    return max(hs, key=lambda p: p[1]), min(ls, key=lambda p: p[1])
