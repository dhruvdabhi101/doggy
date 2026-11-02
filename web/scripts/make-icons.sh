#!/usr/bin/env bash
# Rasterize web/public/icon.svg the same way the Mac app does (sips), then
# flatten the rounded-rect corners onto the orange so a home screen never
# paints them black. Writes the PWA and favicon PNGs.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
SVG="$HERE/../public/icon.svg"
OUT="$HERE/../public"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

sips -s format png -z 1024 1024 "$SVG" --out "$TMP/master.png" >/dev/null
sips -s format png -z 512 512 "$TMP/master.png" --out "$TMP/512.png" >/dev/null

python3 - "$TMP/512.png" "$OUT" <<'PY'
import struct, sys, zlib
master, out = sys.argv[1], sys.argv[2]
ORANGE = (0xC2, 0x55, 0x2D)

def decode(data):
    assert data[:8] == b"\x89PNG\r\n\x1a\n"
    pos, idat = 8, b""
    w = h = depth = ctype = None
    while pos < len(data):
        ln, = struct.unpack(">I", data[pos:pos+4])
        typ = data[pos+4:pos+8]
        body = data[pos+8:pos+8+ln]
        pos += 12 + ln
        if typ == b"IHDR":
            w, h, depth, ctype, _, _, inter = struct.unpack(">IIBBBBB", body)
            assert depth == 8 and ctype == 6 and inter == 0
        elif typ == b"IDAT":
            idat += body
    bpp, stride = 4, w * 4
    raw, rows, prev, i = zlib.decompress(idat), [], bytearray(stride), 0
    for _ in range(h):
        f, line = raw[i], bytearray(raw[i+1:i+1+stride])
        i += 1 + stride
        for x in range(stride):
            a = line[x-bpp] if x >= bpp else 0
            b, c = prev[x], prev[x-bpp] if x >= bpp else 0
            if f == 1: line[x] = (line[x] + a) & 255
            elif f == 2: line[x] = (line[x] + b) & 255
            elif f == 3: line[x] = (line[x] + ((a + b) >> 1)) & 255
            elif f == 4:
                p = a + b - c
                pa, pb, pc = abs(p-a), abs(p-b), abs(p-c)
                line[x] = (line[x] + (a if pa <= pb and pa <= pc else b if pb <= pc else c)) & 255
        rows.append(line)
        prev = line
    return w, h, rows

def chunk(tag, data):
    return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

def write_rgb(path, w, h, rows):
    raw = b"".join(b"\x00" + row for row in rows)
    png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")
    open(path, "wb").write(png)

def flatten(rows):
    out_rows = []
    for row in rows:
        rgb = bytearray()
        for i in range(0, len(row), 4):
            r, g, b, a = row[i:i+4]
            if a == 255:
                rgb += bytes((r, g, b))
            else:
                t = a / 255
                rgb += bytes((
                    round(r * t + ORANGE[0] * (1 - t)),
                    round(g * t + ORANGE[1] * (1 - t)),
                    round(b * t + ORANGE[2] * (1 - t)),
                ))
        out_rows.append(rgb)
    return out_rows

w, h, rows = decode(open(master, "rb").read())
write_rgb(f"{out}/icon-512.png", w, h, flatten(rows))
print(f"wrote {out}/icon-512.png")
PY

# Downscale the flattened 512, which already matches the Mac artwork.
for spec in "192:icon-192.png" "180:apple-touch-icon.png" "32:favicon-32.png"; do
  size="${spec%%:*}"
  name="${spec##*:}"
  sips -s format png -z "$size" "$size" "$OUT/icon-512.png" --out "$OUT/$name" >/dev/null
  echo "wrote $OUT/$name"
done
