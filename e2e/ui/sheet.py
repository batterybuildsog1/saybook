# Contact sheets: one image per scenario label with the four sizes side by side. Usage: python3 sheet.py <outdir> [prefix]
import sys, glob, os, re
from PIL import Image, ImageDraw
d = sys.argv[1]; pre = sys.argv[2] if len(sys.argv) > 2 else ''
files = sorted(glob.glob(os.path.join(d, pre + '*.png')))
groups = {}
for f in files:
    m = re.match(r'(mock|real|mock_night|real_night)-(laptop-1280x529|ipad-1180x820|ipad-820x1180|phone-390x844)-(.+)\.png$', os.path.basename(f))
    if not m: continue
    groups.setdefault((m.group(1), m.group(3)), {})[m.group(2)] = f
order = ['laptop-1280x529', 'ipad-1180x820', 'ipad-820x1180', 'phone-390x844']
H = 640
for (tag, label), g in groups.items():
    ims = []
    for k in order:
        if k in g:
            im = Image.open(g[k]).convert('RGB'); s = H / im.height; ims.append(im.resize((int(im.width * s), H)))
    W = sum(i.width for i in ims) + 20 * (len(ims) + 1)
    sheet = Image.new('RGB', (W, H + 40), (60, 60, 60)); x = 20
    for i in ims: sheet.paste(i, (x, 20)); x += i.width + 20
    os.makedirs(os.path.join(d, 'sheets'), exist_ok=True)
    sheet.save(os.path.join(d, 'sheets', f'{tag}-{label}.jpg'), quality=82)
print('\n'.join(sorted(os.listdir(os.path.join(d, 'sheets')))))
