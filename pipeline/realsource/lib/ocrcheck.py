# OCR guard: is the text we highlight really visible in the screenshot at those rects?
# usage: python3 ocrcheck.py <news.png> <dpr> '<json rects>' '<expected text>'  -> prints ratio of expected words found
import sys, json, re, subprocess, tempfile
from PIL import Image
png, k, rects, text = sys.argv[1], float(sys.argv[2]), json.loads(sys.argv[3]), sys.argv[4]
im = Image.open(png)
x0 = min(r['x'] for r in rects) * k - 10; y0 = min(r['y'] for r in rects) * k - 10
x1 = max(r['x'] + r['w'] for r in rects) * k + 10; y1 = max(r['y'] + r['h'] for r in rects) * k + 10
c = im.crop((max(0, int(x0)), max(0, int(y0)), int(x1), int(y1))).convert('L')
with tempfile.NamedTemporaryFile(suffix='.png') as f:
    c.save(f.name)
    got = subprocess.run(['tesseract', f.name, '-', '--psm', '6'], capture_output=True, text=True).stdout
norm = lambda s: re.findall(r'[a-z0-9]+', s.lower())
want = [w for w in norm(text) if len(w) > 2]
have = set(norm(got))
print(round(sum(w in have for w in want) / max(1, len(want)), 2))
