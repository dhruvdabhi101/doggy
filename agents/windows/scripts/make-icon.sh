#!/usr/bin/env bash
# Regenerates Assets/doggy.ico from web/public/icon.svg (macOS: uses sips).
# Output: multi-size ICO (16..48 as 32-bit BMP/DIB frames, 64..256 as PNG frames).
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
SVG="$HERE/../../web/public/icon.svg"
OUT="$HERE/Assets/doggy.ico"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
for s in 16 24 32 48 64 128 256; do
  sips -s format png "$SVG" --out "$TMP/$s.png" -z "$s" "$s" >/dev/null
done
python3 -I - "$TMP" "$OUT" <<'PY'
import struct, sys, zlib
tmp, out = sys.argv[1], sys.argv[2]

def decode_png(data):
    """Minimal PNG decoder: 8-bit RGB/RGBA, non-interlaced -> list of RGBA rows."""
    assert data[:8] == b'\x89PNG\r\n\x1a\n'
    pos, idat = 8, b''
    while pos < len(data):
        ln, = struct.unpack('>I', data[pos:pos+4]); typ = data[pos+4:pos+8]
        body = data[pos+8:pos+8+ln]; pos += 12 + ln
        if typ == b'IHDR':
            w, h, depth, ctype, _, _, inter = struct.unpack('>IIBBBBB', body)
            assert depth == 8 and ctype in (2, 6) and inter == 0, (depth, ctype, inter)
        elif typ == b'IDAT': idat += body
    bpp = 4 if ctype == 6 else 3
    raw = zlib.decompress(idat); stride = w * bpp
    rows, prev, i = [], bytearray(stride), 0
    for _ in range(h):
        f = raw[i]; line = bytearray(raw[i+1:i+1+stride]); i += 1 + stride
        for x in range(stride):
            a = line[x-bpp] if x >= bpp else 0; b = prev[x]; c = prev[x-bpp] if x >= bpp else 0
            if f == 1: line[x] = (line[x] + a) & 255
            elif f == 2: line[x] = (line[x] + b) & 255
            elif f == 3: line[x] = (line[x] + ((a + b) >> 1)) & 255
            elif f == 4:
                p = a + b - c; pa, pb, pc = abs(p-a), abs(p-b), abs(p-c)
                line[x] = (line[x] + (a if pa <= pb and pa <= pc else b if pb <= pc else c)) & 255
        rows.append(bytes(line) if bpp == 4 else b''.join(bytes(line[j:j+3]) + b'\xff' for j in range(0, stride, 3)))
        prev = line
    return w, h, rows

frames = []
for s in (16, 24, 32, 48, 64, 128, 256):
    png = open(f'{tmp}/{s}.png', 'rb').read()
    if s >= 64:
        frames.append((s, png)); continue
    w, h, rows = decode_png(png)
    xor = b''.join(b''.join(bytes((r[x+2], r[x+1], r[x], r[x+3])) for x in range(0, w*4, 4)) for r in reversed(rows))
    mask_stride = ((w + 31) // 32) * 4
    andmask = b'\x00' * (mask_stride * h)
    hdr = struct.pack('<IiiHHIIiiII', 40, w, h * 2, 1, 32, 0, len(xor) + len(andmask), 0, 0, 0, 0)
    frames.append((s, hdr + xor + andmask))

ico = struct.pack('<HHH', 0, 1, len(frames))
offset = 6 + 16 * len(frames); body = b''
for s, blob in frames:
    ico += struct.pack('<BBBBHHII', s % 256, s % 256, 0, 0, 1, 32, len(blob), offset)
    offset += len(blob); body += blob
open(out, 'wb').write(ico + body)
print(f'wrote {out} ({len(ico) + len(body)} bytes, {len(frames)} sizes)')
PY
