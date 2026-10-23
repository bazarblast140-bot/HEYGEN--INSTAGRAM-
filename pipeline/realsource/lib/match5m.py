"""Match TradingView 5m bars to Yahoo ^NSEI 5m rows BY TIME SLOT, over the same cutoff.

TradingView draws one candle per 5-minute slot from 09:15 with no gaps; Yahoo
sometimes returns null rows (dropped) and is ~15 min ahead of TradingView's
delayed public feed. So: TradingView bar i of today = slot 09:15 + 5*i; it is
compared only with the Yahoo row of that same slot, and Yahoo's day high/low
are taken only over slots TradingView also shows (same cutoff window).
"""
import datetime as dt

def slot(i): return (dt.datetime(2000, 1, 1, 9, 15) + dt.timedelta(minutes=5 * i)).strftime('%H:%M')
# TradingView's 09:15 5m candle opens at the first continuous trade; Yahoo's (and the
# official/daily) open is the pre-open auction price. That one field is a different
# quantity, not feed noise, so it is not compared here; the printed open is the
# official daily open, which build.mjs checks exactly against Yahoo.
def fields(r): return ('h', 'l', 'c') if r.get('time') == '09:15' else ('o', 'h', 'l', 'c')
def dev(b, r): return max(abs(b[k] - r[k]) for k in fields(r))

def positions(bars, spacing=None):
    """Chart-slot index of each bar from its x position. The legend sweep can miss a
    bar (23 Oct 2026 runs 39908584540/39920316301/39921845117: no run at x=677 between
    670 and 684, spacing 7), and counting bars by list index then labelled every later
    bar one slot early. A gap of n spacings advances the slot by n."""
    if not bars: return []
    xs = [b.get('xCss') for b in bars]
    if None in xs: return list(range(len(bars)))
    if not spacing:
        gaps = sorted(xs[i + 1] - xs[i] for i in range(len(xs) - 1))
        spacing = gaps[len(gaps) // 2] if gaps else 1
    pos = [0]
    for i in range(1, len(xs)): pos.append(pos[-1] + max(1, round((xs[i] - xs[i - 1]) / spacing)))
    return pos

def align(bars, ytoday, spacing=None):
    """Best k (index of today's 09:15 bar in `bars`): smallest max deviation over the
    complete (non-newest) bars that have a Yahoo row in the same slot.

    Either feed may be ahead: Yahoo is usually ahead of TradingView, but it can also
    lag it by several bars (21 Oct 2026 run 39552391975: Yahoo's last row was 2+ bars
    older than TradingView's). Candidate alignments are therefore NOT filtered by how
    many TradingView bars are newer than Yahoo's last row; that filter rejected the
    true alignment and forced a one-slot shift (every bar labelled 5 min early). Bars
    newer than Yahoo simply have no pair and stay unverified downstream."""
    ymap = {r['time']: r for r in ytoday}
    if not ymap: return None
    best = None
    pos = positions(bars, spacing)
    for k in range(len(bars)):
        tvN = len(bars) - k
        if tvN < 3: continue
        pairs = [(bars[j], ymap[slot(pos[j] - pos[k])]) for j in range(k, len(bars) - 1) if slot(pos[j] - pos[k]) in ymap]
        if len(pairs) < 2: continue
        d = max(dev(b, r) for b, r in pairs)
        # lower deviation wins; on a tie, the alignment that verifies more bars
        if best is None or d < best[1] or (d == best[1] and len(pairs) > best[2]): best = (k, d, len(pairs))
    return best[:2] if best else None

def yahoo_window(ytoday, last_time):
    """Yahoo rows up to and including TradingView's last slot (same cutoff)."""
    return [r for r in ytoday if r['time'] <= last_time]

def complete(tb, after_close):
    """TradingView bars that are finished: all after the close, else all but the newest (live) one."""
    return list(tb) if after_close else list(tb[:-1])
