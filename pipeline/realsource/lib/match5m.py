"""Match TradingView 5m bars to Yahoo ^NSEI 5m rows BY TIME SLOT, over the same cutoff.

TradingView draws one candle per 5-minute slot from 09:15 with no gaps; Yahoo
sometimes returns null rows (dropped) and is ~15 min ahead of TradingView's
delayed public feed. So: TradingView bar i of today = slot 09:15 + 5*i; it is
compared only with the Yahoo row of that same slot, and Yahoo's day high/low
are taken only over slots TradingView also shows (same cutoff window).
"""
import datetime as dt

def slot(i): return (dt.datetime(2000, 1, 1, 9, 15) + dt.timedelta(minutes=5 * i)).strftime('%H:%M')
def dev(b, r): return max(abs(b[k] - r[k]) for k in ('o', 'h', 'l', 'c'))

def align(bars, ytoday):
    """Best k (index of today's 09:15 bar in `bars`): smallest max deviation over the
    complete (non-newest) bars that have a Yahoo row in the same slot."""
    ymap = {r['time']: r for r in ytoday}
    ylast = max((r['time'] for r in ytoday), default=None)
    best = None
    for k in range(len(bars)):
        tvN = len(bars) - k
        if tvN < 3 or ylast is None: continue
        if sum(1 for i in range(tvN) if slot(i) > ylast) > 1: continue  # at most one TradingView bar newer than Yahoo's
        pairs = [(bars[k + i], ymap[slot(i)]) for i in range(tvN - 1) if slot(i) in ymap]
        if len(pairs) < 2: continue
        d = max(dev(b, r) for b, r in pairs)
        if best is None or d < best[1]: best = (k, d)
    return best

def yahoo_window(ytoday, last_time):
    """Yahoo rows up to and including TradingView's last slot (same cutoff)."""
    return [r for r in ytoday if r['time'] <= last_time]
