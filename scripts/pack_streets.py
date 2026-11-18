#!/usr/bin/env python3
"""Pack the lit streets into a compact binary the phone can decode off the main thread.

Format (little-endian), magic KRD1:
  u8 version = 1
  f32 originLon, originLat, spanLon, spanLat
  u32 lineCount
  repeated lineCount times:
    u16 driveTimeSeconds   (bucket start; the line appears when reveal >= this)
    u8  band               (1, 2, or 3)
    u8  pointCount
    pointCount times: u16 x, u16 y
      x = round((lon - originLon) / spanLon * 65535)

The whole 15-minute area fits in one uint16 grid at about 1 meter.
streets.geojson stays in the repo as the readable source; the map loads streets.bin.
"""

from __future__ import annotations

import json
import struct
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "public" / "data" / "streets.geojson"
DEST = ROOT / "public" / "data" / "streets.bin"


def pack(src: Path = SRC, dest: Path = DEST) -> None:
    data = json.loads(src.read_text())
    raw: list[tuple[int, int, list[list[float]]]] = []
    min_lon = min_lat = 1e9
    max_lon = max_lat = -1e9
    for feature in data["features"]:
        band = int(feature["properties"]["band"])
        if band > 3:
            continue
        seconds = int(feature["properties"]["t"])
        for line in feature["geometry"]["coordinates"]:
            if len(line) < 2:
                continue
            raw.append((seconds, band, line))
            for lon, lat in line:
                min_lon = min(min_lon, lon)
                min_lat = min(min_lat, lat)
                max_lon = max(max_lon, lon)
                max_lat = max(max_lat, lat)
    pad = 1e-4
    origin_lon = min_lon - pad
    origin_lat = min_lat - pad
    span_lon = (max_lon - min_lon) + 2 * pad
    span_lat = (max_lat - min_lat) + 2 * pad

    def quantize(lon: float, lat: float) -> tuple[int, int]:
        x = int(round((lon - origin_lon) / span_lon * 65535))
        y = int(round((lat - origin_lat) / span_lat * 65535))
        return max(0, min(65535, x)), max(0, min(65535, y))

    body = bytearray()
    written = 0
    max_error_m = 0.0
    for seconds, band, line in raw:
        points = [quantize(lon, lat) for lon, lat in line]
        compact = [points[0]]
        for point in points[1:]:
            if point != compact[-1]:
                compact.append(point)
        if len(compact) < 2:
            continue
        chunks = [compact[i : i + 255] for i in range(0, len(compact), 254)]
        # Overlap the join point so a split line stays connected.
        if len(compact) > 255:
            chunks = []
            i = 0
            while i < len(compact) - 1:
                chunks.append(compact[i : i + 255])
                i += 254
        for chunk in chunks:
            if len(chunk) < 2:
                continue
            body += struct.pack("<HBB", seconds, band, len(chunk))
            for x, y in chunk:
                body += struct.pack("<HH", x, y)
            written += 1
        for lon, lat in line:
            qx = origin_lon + (quantize(lon, lat)[0] / 65535) * span_lon
            qy = origin_lat + (quantize(lon, lat)[1] / 65535) * span_lat
            max_error_m = max(max_error_m, abs(qx - lon) * 83000, abs(qy - lat) * 111_320)

    header = b"KRD1" + struct.pack("<B4fI", 1, origin_lon, origin_lat, span_lon, span_lat, written)
    dest.write_bytes(header + body)
    print(
        f"packed {written} lines -> {dest.name} {dest.stat().st_size / 1e6:.2f} MB "
        f"(from {src.stat().st_size / 1e6:.2f} MB), max quantize error {max_error_m:.2f} m"
    )


if __name__ == "__main__":
    source = Path(sys.argv[1]) if len(sys.argv) > 1 else SRC
    target = Path(sys.argv[2]) if len(sys.argv) > 2 else DEST
    pack(source, target)
