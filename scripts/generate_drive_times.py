#!/usr/bin/env python3
"""Drive times from The Kendall School, Belmont.

Free-flow time on each street is length / speed. Speed is the OpenStreetMap
maxspeed tag when it parses, otherwise a posted-speed default for that highway
class (see FREEFLOW_MPH). No traffic lights and no congestion.

Rush hour later
---------------
Set GLOBAL_RUSH_MULTIPLIER above 1, and/or set per-class values in RUSH_FACTOR,
then rerun this script. Both multiply travel time (1.4 means 40% slower).
INTERSECTION_DELAY_S adds a fixed wait, in seconds, on arrival at a junction
with three or more road ends. Leave it at 0 for pure free-flow.

Outputs (under public/data)
---------------------------
streets.geojson         0–15 min, drawn by the map
streets-15-20.geojson   15–20 min, not drawn; kept so every reached street exists
travel-grid.json        minute lookup for a future listings pin
meta.json               school, colors, camera bounds
method.json             what this run actually did
"""

from __future__ import annotations

import argparse
import base64
import gc
import json
import math
import subprocess
import sys
import time
import urllib.request
from array import array
from collections import Counter
from pathlib import Path

import numpy as np
import osmium
from scipy.ndimage import distance_transform_edt
from scipy.sparse import csr_matrix
from scipy.sparse.csgraph import dijkstra

ROOT = Path(__file__).resolve().parents[1]
CACHE = ROOT / "data" / "cache"
OUT = ROOT / "public" / "data"
PBF_URL = "https://download.geofabrik.de/north-america/us/massachusetts-latest.osm.pbf"

# Nominatim centroid of OSM way 29580670, checked inside the building footprint.
# The run replaces this with the footprint centroid from the extract and checks
# the two still land on the same building.
REF_LAT = 42.3798286
REF_LON = -71.1763901
SCHOOL_WAY_ID = 29580670
SCHOOL_NAME = "Kendall School"

RADIUS_M = 42_000
MAX_SECONDS = 20 * 60
BUCKET_S = 5
SIMPLIFY_M = 4.0
CELL_M = 90.0
SEARCH_M = 175.0
ORIGIN = -1

# Posted-style free-flow speeds in mph, used only when maxspeed is missing.
FREEFLOW_MPH = {
    "motorway": 65,
    "motorway_link": 40,
    "trunk": 50,
    "trunk_link": 30,
    "primary": 35,
    "primary_link": 25,
    "secondary": 30,
    "secondary_link": 25,
    "tertiary": 25,
    "tertiary_link": 25,
    "unclassified": 25,
    "residential": 25,
    "living_street": 10,
}
# Multiply travel time. 1.0 is free-flow. Example rush sketch (do not enable here):
#   motorway 1.35, primary 1.7, secondary 1.55, tertiary 1.4, residential 1.25
RUSH_FACTOR = {name: 1.0 for name in FREEFLOW_MPH}
GLOBAL_RUSH_MULTIPLIER = 1.0
INTERSECTION_DELAY_S = 0.0

MPH_TO_KMH = 1.609344
LAT0 = math.radians(42.38)
M_PER_DEG_LAT = 111_320.0
M_PER_DEG_LON = 111_320.0 * math.cos(LAT0)

BANDS = [
    {"band": 1, "label": "0–5 min", "minSec": 0, "maxSec": 300, "color": "#FFC857", "core": "#FFF3CC"},
    {"band": 2, "label": "5–10 min", "minSec": 300, "maxSec": 600, "color": "#FF6B3D", "core": "#FFD0C4"},
    {"band": 3, "label": "10–15 min", "minSec": 600, "maxSec": 900, "color": "#7EB6FF", "core": "#E7F1FF"},
]
NOTE = "Free-flow speeds, not rush hour. Past 15 minutes the roads stay dark."

HEAD_DEGREE: dict[int, int] = {}
AVOID = {"motorway", "motorway_link", "trunk", "trunk_link"}


def log(message: str) -> None:
    print(f"[{time.strftime('%H:%M:%S')}] {message}", flush=True)


def rss_mb() -> float:
    try:
        for line in Path("/proc/self/status").read_text().splitlines():
            if line.startswith("VmRSS:"):
                return int(line.split()[1]) / 1024
    except OSError:
        return -1
    return -1


def meters(lon1: float, lat1: float, lon2: float, lat2: float) -> float:
    return math.hypot((lon2 - lon1) * M_PER_DEG_LON, (lat2 - lat1) * M_PER_DEG_LAT)


def project_point(lon: float, lat: float, lon1: float, lat1: float, lon2: float, lat2: float):
    x = (lon - lon1) * M_PER_DEG_LON
    y = (lat - lat1) * M_PER_DEG_LAT
    dx = (lon2 - lon1) * M_PER_DEG_LON
    dy = (lat2 - lat1) * M_PER_DEG_LAT
    denom = dx * dx + dy * dy
    if denom < 1e-8:
        return meters(lon, lat, lon1, lat1), 0.0, lon1, lat1
    frac = max(0.0, min(1.0, (x * dx + y * dy) / denom))
    px = lon1 + (lon2 - lon1) * frac
    py = lat1 + (lat2 - lat1) * frac
    return meters(lon, lat, px, py), frac, px, py


def point_in_ring(lon: float, lat: float, ring: list[tuple[float, float]]) -> bool:
    if ring[0] != ring[-1]:
        ring = [*ring, ring[0]]
    inside = False
    for i in range(len(ring) - 1):
        x1, y1 = ring[i]
        x2, y2 = ring[i + 1]
        if (y1 > lat) != (y2 > lat):
            xint = (x2 - x1) * (lat - y1) / (y2 - y1) + x1
            if lon < xint:
                inside = not inside
    return inside


def ring_centroid(ring: list[tuple[float, float]]) -> tuple[float, float]:
    """Shoelace centroid in local meters. Raw lon/lat crosses underflow on a small building."""
    if ring[0] != ring[-1]:
        ring = [*ring, ring[0]]
    lon0, lat0 = ring[0]
    pts = [((lon - lon0) * M_PER_DEG_LON, (lat - lat0) * M_PER_DEG_LAT) for lon, lat in ring]
    twice = 0.0
    cx = 0.0
    cy = 0.0
    for i in range(len(pts) - 1):
        x1, y1 = pts[i]
        x2, y2 = pts[i + 1]
        cross = x1 * y2 - x2 * y1
        twice += cross
        cx += (x1 + x2) * cross
        cy += (y1 + y2) * cross
    if abs(twice) < 1e-6:
        n = len(ring) - 1
        return sum(p[0] for p in ring[:n]) / n, sum(p[1] for p in ring[:n]) / n
    return lon0 + (cx / (3 * twice)) / M_PER_DEG_LON, lat0 + (cy / (3 * twice)) / M_PER_DEG_LAT


def interior_point(ring: list[tuple[float, float]]) -> tuple[float, float]:
    closed = ring if ring[0] == ring[-1] else [*ring, ring[0]]
    centroid = ring_centroid(closed)
    if point_in_ring(centroid[0], centroid[1], closed):
        return centroid
    n = len(closed) - 1
    average = (sum(p[0] for p in closed[:n]) / n, sum(p[1] for p in closed[:n]) / n)
    if point_in_ring(average[0], average[1], closed):
        return average
    if point_in_ring(REF_LON, REF_LAT, closed):
        return REF_LON, REF_LAT
    raise SystemExit("school footprint has no interior point to anchor the map")


def parse_maxspeed(raw: str | None) -> float | None:
    if not raw:
        return None
    part = raw.split(";")[0].split("|")[0].strip().lower()
    if part in {"", "signals", "none", "variable", "walk", "national", "unlimited"}:
        return None
    mph = "mph" in part
    part = part.replace("mph", "").replace("km/h", "").replace("kph", "").strip()
    try:
        value = float(part)
    except ValueError:
        return None
    if value <= 0:
        return None
    return value * MPH_TO_KMH if mph else value


def parse_directions(oneway: str, junction: str, highway: str) -> tuple[bool, bool]:
    value = oneway.strip().lower()
    if value in {"yes", "true", "1"}:
        return True, False
    if value in {"-1", "reverse"}:
        return False, True
    if value in {"no", "false", "0"}:
        return True, True
    if junction == "roundabout" or highway in {"motorway", "motorway_link"}:
        return True, False
    return True, True


def travel_seconds(length_m: float, speed_kmh: float, highway: str, *, at_intersection: bool = False) -> float:
    mps = speed_kmh * (1000.0 / 3600.0)
    seconds = (length_m / mps) * RUSH_FACTOR.get(highway, 1.0) * GLOBAL_RUSH_MULTIPLIER
    if at_intersection:
        seconds += INTERSECTION_DELAY_S
    return seconds


def edge_seconds(length_m: float, speed_kmh: float, highway: str, head: int) -> float:
    at_intersection = INTERSECTION_DELAY_S > 0 and HEAD_DEGREE.get(head, 0) >= 3
    return travel_seconds(length_m, speed_kmh, highway, at_intersection=at_intersection)


def band_of(bucket: int) -> int:
    if bucket < 300:
        return 1
    if bucket < 600:
        return 2
    if bucket < 900:
        return 3
    return 4


def dedupe_coords(coords: list[list[float]]) -> list[list[float]]:
    out: list[list[float]] = []
    for coord in coords:
        if not out or coord[0] != out[-1][0] or coord[1] != out[-1][1]:
            out.append(coord)
    return out


def douglas_peucker(coords: list[list[float]], tol_m: float) -> list[list[float]]:
    if len(coords) < 3:
        return [[round(c[0], 5), round(c[1], 5)] for c in coords]
    lon0, lat0 = coords[0]

    def xy(coord: list[float]) -> tuple[float, float]:
        return ((coord[0] - lon0) * M_PER_DEG_LON, (coord[1] - lat0) * M_PER_DEG_LAT)

    def rec(points: list[list[float]]) -> list[list[float]]:
        if len(points) < 3:
            return points
        ax, ay = xy(points[0])
        bx, by = xy(points[-1])
        dx, dy = bx - ax, by - ay
        denom = dx * dx + dy * dy
        max_d = -1.0
        index = 0
        for i in range(1, len(points) - 1):
            px, py = xy(points[i])
            if denom == 0:
                dist = math.hypot(px - ax, py - ay)
            else:
                along = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / denom))
                dist = math.hypot(px - (ax + along * dx), py - (ay + along * dy))
            if dist > max_d:
                max_d = dist
                index = i
        if max_d <= tol_m:
            return [points[0], points[-1]]
        return rec(points[: index + 1])[:-1] + rec(points[index:])

    simplified = [[round(c[0], 5), round(c[1], 5)] for c in rec(coords)]
    return dedupe_coords(simplified)


def clip_segment(p, q, max_t: float):
    t0, t1 = p[2], q[2]
    if t0 is None or t1 is None:
        return None
    if t0 > max_t and t1 > max_t:
        return None
    if t0 <= max_t and t1 <= max_t:
        return p, q
    if t1 == t0:
        return None
    frac = (max_t - t0) / (t1 - t0)
    mid = (p[0] + (q[0] - p[0]) * frac, p[1] + (q[1] - p[1]) * frac, max_t)
    return (p, mid) if t0 <= max_t else (mid, q)


class LineBuilder:
    def __init__(self) -> None:
        self.bucket: int | None = None
        self.coords: list[list[float]] = []
        self.timed: list[tuple] = []
        self.out: list[tuple[int, list[list[float]], list[tuple]]] = []

    def flush(self) -> None:
        if len(self.coords) >= 2 and self.bucket is not None:
            simplified = douglas_peucker(self.coords, SIMPLIFY_M)
            if len(simplified) >= 2:
                self.out.append((self.bucket, simplified, self.timed))
        self.coords = []
        self.timed = []
        self.bucket = None

    def add_segment(self, a, b) -> None:
        bucket = int(min(a[2], b[2]) // BUCKET_S) * BUCKET_S
        mismatch = False
        if self.coords:
            last = self.coords[-1]
            mismatch = abs(last[0] - a[0]) > 1e-7 or abs(last[1] - a[1]) > 1e-7
        if self.bucket != bucket or mismatch or not self.coords:
            self.flush()
            self.bucket = bucket
            self.coords = [[a[0], a[1]]]
            self.timed = [a]
        self.coords.append([b[0], b[1]])
        self.timed.append(b)


def sample_gs(t_fn):
    def rec(g0, t0, g1, t1, depth):
        if depth >= 11:
            return [(g0, t0), (g1, t1)]
        if t0 is None and t1 is None:
            return [(g0, None), (g1, None)]
        gm = (g0 + g1) * 0.5
        tm = t_fn(gm)
        if (
            t0 is not None
            and t1 is not None
            and tm is not None
            and min(t0, t1, tm) > MAX_SECONDS
        ):
            return [(g0, t0), (g1, t1)]
        hump = t0 is not None and t1 is not None and tm is not None and tm > max(t0, t1) + 5
        wide = t0 is not None and t1 is not None and abs(t1 - t0) > 5
        gap = (t0 is None) != (t1 is None)
        if depth == 0 or hump or wide or gap:
            return rec(g0, t0, gm, tm, depth + 1)[:-1] + rec(gm, tm, g1, t1, depth + 1)
        return [(g0, t0), (g1, t1)]

    return rec(0.0, t_fn(0.0), 1.0, t_fn(1.0), 0)


def self_test() -> None:
    mile = 1609.344
    mph60 = 60 * MPH_TO_KMH
    got = travel_seconds(mile, mph60, "residential")
    assert abs(got - 60.0) < 0.05, got
    assert abs(parse_maxspeed("25 mph") - 25 * MPH_TO_KMH) < 1e-6
    assert parse_maxspeed("40") == 40
    assert parse_maxspeed("signals") is None
    square = [(0.0, 0.0), (1.0, 0.0), (1.0, 1.0), (0.0, 1.0), (0.0, 0.0)]
    centroid = ring_centroid(square)
    assert abs(centroid[0] - 0.5) < 1e-9 and abs(centroid[1] - 0.5) < 1e-9
    assert point_in_ring(0.5, 0.5, square)
    assert not point_in_ring(1.5, 0.5, square)
    building = [
        (-71.1765079, 42.3797981),
        (-71.1764887, 42.3797946),
        (-71.1765075, 42.3797379),
        (-71.1763728, 42.3797136),
        (-71.1763468, 42.3797919),
        (-71.1762974, 42.379783),
        (-71.1762705, 42.3798641),
        (-71.1764537, 42.3798972),
        (-71.1764664, 42.379859),
        (-71.1764865, 42.3798627),
        (-71.1765079, 42.3797981),
    ]
    door = interior_point(building)
    assert point_in_ring(door[0], door[1], building)
    assert meters(door[0], door[1], REF_LON, REF_LAT) < 20
    tent = sample_gs(lambda g: min(g * 100, (1 - g) * 100))
    assert any(t is not None and t >= 40 for _, t in tent)
    mono = [t for _, t in sample_gs(lambda g: g * 30) if t is not None]
    assert mono[0] == 0 and abs(mono[-1] - 30) < 1e-6
    for left, right in zip(mono, mono[1:]):
        assert abs(right - left) <= 5.01
    forward, backward = parse_directions("", "roundabout", "residential")
    assert forward and not backward
    both = parse_directions("no", "", "primary")
    assert both == (True, True)
    log("self-test ok")


class Collector(osmium.SimpleHandler):
    def __init__(self) -> None:
        super().__init__()
        self.node_ll: dict[int, tuple[float, float]] = {}
        self.ways: list[tuple] = []
        self.near_ways: list[int] = []
        self.school_ring: list[tuple[float, float]] | None = None
        self.school_tags: dict[str, str] = {}
        self.highways = Counter()
        self.maxspeed_used = 0
        self.default_used = 0
        self.skipped_access = 0
        self.skipped_broken = 0

    def way(self, w) -> None:  # noqa: ANN001
        if w.id == SCHOOL_WAY_ID:
            ring = []
            for node in w.nodes:
                if node.location.valid():
                    ring.append((float(node.location.lon), float(node.location.lat)))
            self.school_ring = ring
            tags: dict[str, str] = {}
            for tag in w.tags:
                key = getattr(tag, "k", None)
                value = getattr(tag, "v", None)
                if key is None:
                    key, value = tag
                tags[str(key)] = str(value)
            self.school_tags = tags
            return
        highway = w.tags.get("highway")
        if not highway or str(highway) not in FREEFLOW_MPH:
            return
        highway = str(highway)
        access = str(w.tags.get("access") or "")
        motor = str(w.tags.get("motor_vehicle") or "")
        motorcar = str(w.tags.get("motorcar") or "")
        if access == "no" or motor == "no" or motorcar == "no" or str(w.tags.get("area") or "") == "yes":
            self.skipped_access += 1
            return
        refs = array("q")
        lons = []
        lats = []
        for node in w.nodes:
            if not node.location.valid():
                self.skipped_broken += 1
                return
            ref = int(node.ref)
            lon = float(node.location.lon)
            lat = float(node.location.lat)
            refs.append(ref)
            lons.append(lon)
            lats.append(lat)
            self.node_ll[ref] = (lon, lat)
        if len(refs) < 2:
            return
        raw_speed = w.tags.get("maxspeed")
        parsed = parse_maxspeed(str(raw_speed) if raw_speed else None)
        if parsed is None or not 7 <= parsed <= 140:
            speed = FREEFLOW_MPH[highway] * MPH_TO_KMH
            self.default_used += 1
        else:
            speed = parsed
            self.maxspeed_used += 1
        can_f, can_b = parse_directions(
            str(w.tags.get("oneway") or ""),
            str(w.tags.get("junction") or ""),
            highway,
        )
        near = (
            min(lons) <= REF_LON + 0.012
            and max(lons) >= REF_LON - 0.012
            and min(lats) <= REF_LAT + 0.012
            and max(lats) >= REF_LAT - 0.012
        )
        name = str(w.tags["name"]) if near and "name" in w.tags else None
        self.ways.append((refs, speed, highway, can_f, can_b, name))
        if near:
            self.near_ways.append(len(self.ways) - 1)
        self.highways[highway] += 1
        if len(self.ways) % 50000 == 0:
            log(f"kept {len(self.ways):,} roads")


def add_min(best: dict[tuple[int, int], float], u: int, v: int, seconds: float) -> None:
    if u == v or not math.isfinite(seconds) or seconds < 0:
        return
    prev = best.get((u, v))
    if prev is None or seconds < prev:
        best[(u, v)] = seconds


def bbox_from(lat: float, lon: float, radius_m: float) -> tuple[float, float, float, float]:
    dlat = radius_m / M_PER_DEG_LAT
    dlon = radius_m / M_PER_DEG_LON
    return lon - dlon, lat - dlat, lon + dlon, lat + dlat


def find_pbf() -> Path:
    candidates = [
        CACHE / "massachusetts-latest.osm.pbf",
        Path("/tmp/osm-cache/massachusetts-latest.osm.pbf"),
    ]
    for path in candidates:
        if path.exists() and path.stat().st_size > 50_000_000:
            log(f"using extract {path} ({path.stat().st_size / 1e6:.0f} MB)")
            return path
    dest = candidates[0]
    dest.parent.mkdir(parents=True, exist_ok=True)
    log(f"downloading Massachusetts OSM extract to {dest}")
    request = urllib.request.Request(PBF_URL, headers={"User-Agent": "kendall-house-hunt/1.0"})
    with urllib.request.urlopen(request, timeout=180) as response, dest.open("wb") as handle:
        while True:
            chunk = response.read(1024 * 1024)
            if not chunk:
                break
            handle.write(chunk)
    return dest


def ensure_roads(pbf: Path, west: float, south: float, east: float, north: float, force: bool) -> Path:
    CACHE.mkdir(parents=True, exist_ok=True)
    roads = CACHE / "roads.osm.pbf"
    clip = CACHE / "clip.osm.pbf"
    stamp_path = CACHE / "roads-stamp.json"
    stamp = {
        "bbox": [round(west, 5), round(south, 5), round(east, 5), round(north, 5)],
        "pbf_size": pbf.stat().st_size,
        "highways": list(FREEFLOW_MPH),
    }
    if roads.exists() and stamp_path.exists() and not force:
        try:
            previous = json.loads(stamp_path.read_text())
        except json.JSONDecodeError:
            previous = None
        if previous == stamp:
            log(f"reusing {roads}")
            return roads
    log("clipping Massachusetts to the 20-minute search box")
    subprocess.check_call(
        [
            "osmium",
            "extract",
            "--bbox",
            f"{west:.6f},{south:.6f},{east:.6f},{north:.6f}",
            "--strategy",
            "simple",
            "--overwrite",
            "--progress",
            "-o",
            str(clip),
            str(pbf),
        ]
    )
    highway_filter = "w/highway=" + ",".join(FREEFLOW_MPH)
    log("keeping drivable streets and the school building")
    subprocess.check_call(
        [
            "osmium",
            "tags-filter",
            "--overwrite",
            "--progress",
            "-o",
            str(roads),
            str(clip),
            highway_filter,
            "w/amenity=school",
        ]
    )
    stamp_path.write_text(json.dumps(stamp))
    return roads


def make_normal(ta, tb, tt_f, tt_b):
    def t_fn(g: float):
        cands = []
        if ta is not None and tt_f is not None:
            cands.append(ta + g * tt_f)
        if tb is not None and tt_b is not None:
            cands.append(tb + (1.0 - g) * tt_b)
        if not cands:
            return None
        return max(0.0, min(cands))

    return t_fn


def make_snap_time(frac, full_drive, can_f, can_b, delay_a, delay_b, ta, tb):
    def t_fn(g: float):
        if can_f and can_b:
            if g >= frac:
                base = (g - frac) * full_drive
                if g >= 1 - 1e-9:
                    base += delay_b
                return max(0.0, base)
            base = (frac - g) * full_drive
            if g <= 1e-9:
                base += delay_a
            return max(0.0, base)
        if can_f:
            if g >= frac - 1e-12:
                base = (g - frac) * full_drive
                if g >= 1 - 1e-9:
                    base += delay_b
                return max(0.0, base)
            if ta is None:
                return None
            return max(0.0, ta + g * full_drive)
        if can_b:
            if g <= frac + 1e-12:
                base = (frac - g) * full_drive
                if g <= 1e-9:
                    base += delay_a
                return max(0.0, base)
            if tb is None:
                return None
            return max(0.0, tb + (1.0 - g) * full_drive)
        return None

    return t_fn


def expand(bounds, lon: float, lat: float):
    if bounds is None:
        return [lon, lat, lon, lat]
    bounds[0] = min(bounds[0], lon)
    bounds[1] = min(bounds[1], lat)
    bounds[2] = max(bounds[2], lon)
    bounds[3] = max(bounds[3], lat)
    return bounds


def remember_grid(samples: list[tuple[float, float, float]], timed: list[tuple]) -> None:
    if not timed:
        return
    for index in range(len(timed) - 1):
        p = timed[index]
        q = timed[index + 1]
        if p[2] is None or q[2] is None:
            continue
        if p[2] > MAX_SECONDS and q[2] > MAX_SECONDS:
            continue
        samples.append((p[0], p[1], p[2] / 60.0))
        dist = meters(p[0], p[1], q[0], q[1])
        steps = int(dist // 50)
        for step in range(1, steps):
            frac = step / steps
            samples.append(
                (
                    p[0] + (q[0] - p[0]) * frac,
                    p[1] + (q[1] - p[1]) * frac,
                    (p[2] + (q[2] - p[2]) * frac) / 60.0,
                )
            )
    last = timed[-1]
    if last[2] is not None and last[2] <= MAX_SECONDS:
        samples.append((last[0], last[1], last[2] / 60.0))


def render_ways(ways, node_ll, time_of, snap):
    buckets: dict[int, list] = {}
    band_km = {1: 0.0, 2: 0.0, 3: 0.0, 4: 0.0}
    band_bounds = {1: None, 2: None, 3: None, 4: None}
    grid_samples: list[tuple[float, float, float]] = []
    for wi, way in enumerate(ways):
        refs, speed, highway, can_f, can_b, _name = way
        samples = []
        for hi in range(len(refs) - 1):
            a = int(refs[hi])
            b = int(refs[hi + 1])
            la = node_ll[a]
            lb = node_ll[b]
            length = meters(la[0], la[1], lb[0], lb[1])
            if length < 0.4:
                continue
            if wi == snap["way"] and hi == snap["hop"]:
                t_fn = snap["t_fn"]
            else:
                ta = time_of.get(a)
                tb = time_of.get(b)
                if ta is None and tb is None:
                    samples.append((lb[0], lb[1], None))
                    continue
                tt_f = edge_seconds(length, speed, highway, b) if can_f else None
                tt_b = edge_seconds(length, speed, highway, a) if can_b else None
                t_fn = make_normal(ta, tb, tt_f, tt_b)
                t0 = t_fn(0.0)
                t1 = t_fn(1.0)
                if (t0 is None or t0 > MAX_SECONDS) and (t1 is None or t1 > MAX_SECONDS):
                    samples.append((lb[0], lb[1], None))
                    continue
            for index, (g, t) in enumerate(sample_gs(t_fn)):
                if samples and index == 0 and samples[-1][2] is not None:
                    continue
                samples.append((la[0] + (lb[0] - la[0]) * g, la[1] + (lb[1] - la[1]) * g, t))
        builder = LineBuilder()
        prev = None
        for sample in samples:
            if prev is None:
                prev = sample
                continue
            segment = clip_segment(prev, sample, MAX_SECONDS)
            prev = sample
            if segment is None:
                builder.flush()
                continue
            builder.add_segment(*segment)
        builder.flush()
        for bucket, coords, timed in builder.out:
            band = band_of(bucket)
            buckets.setdefault(bucket, []).append(coords)
            for lon, lat in coords:
                band_bounds[band] = expand(band_bounds[band], lon, lat)
            for index in range(len(timed) - 1):
                p = timed[index]
                q = timed[index + 1]
                if p[2] is None or q[2] is None:
                    continue
                band_km[band] += meters(p[0], p[1], q[0], q[1]) / 1000.0
            remember_grid(grid_samples, timed)
        if wi and wi % 40000 == 0:
            log(f"styled {wi:,}/{len(ways):,} streets")
    return buckets, band_km, band_bounds, grid_samples


def features_from(buckets: dict[int, list], allowed: set[int]) -> dict:
    features = []
    for bucket in sorted(buckets):
        band = band_of(bucket)
        if band not in allowed or not buckets[bucket]:
            continue
        features.append(
            {
                "type": "Feature",
                "properties": {"t": int(bucket), "band": band},
                "geometry": {"type": "MultiLineString", "coordinates": buckets[bucket]},
            }
        )
    return {"type": "FeatureCollection", "features": features}


def union_bounds(parts, school_lon: float, school_lat: float) -> list[float]:
    bounds = [school_lon, school_lat, school_lon, school_lat]
    for part in parts:
        if part is None:
            continue
        bounds[0] = min(bounds[0], part[0])
        bounds[1] = min(bounds[1], part[1])
        bounds[2] = max(bounds[2], part[2])
        bounds[3] = max(bounds[3], part[3])
    return [round(v, 5) for v in bounds]


def build_grid(samples, school_lon: float, school_lat: float):
    pad_lat = (SEARCH_M + CELL_M) / M_PER_DEG_LAT
    pad_lon = (SEARCH_M + CELL_M) / M_PER_DEG_LON
    min_lon = min(s[0] for s in samples) - pad_lon
    max_lon = max(s[0] for s in samples) + pad_lon
    min_lat = min(s[1] for s in samples) - pad_lat
    max_lat = max(s[1] for s in samples) + pad_lat
    min_lon = min(min_lon, school_lon - pad_lon)
    max_lon = max(max_lon, school_lon + pad_lon)
    min_lat = min(min_lat, school_lat - pad_lat)
    max_lat = max(max_lat, school_lat + pad_lat)
    cell_lat = CELL_M / M_PER_DEG_LAT
    cell_lon = CELL_M / M_PER_DEG_LON
    cols = int(math.ceil((max_lon - min_lon) / cell_lon)) + 1
    rows = int(math.ceil((max_lat - min_lat) / cell_lat)) + 1
    if cols * rows > 1_500_000:
        raise SystemExit(f"drive-time grid is unexpectedly large ({cols} x {rows})")
    painted = np.full((rows, cols), 255, dtype=np.uint8)
    best_d = np.full((rows, cols), np.float32(np.inf))
    for lon, lat, minutes in samples:
        if minutes > 20.05:
            continue
        col = int((lon - min_lon) / cell_lon)
        row = int((lat - min_lat) / cell_lat)
        if not (0 <= row < rows and 0 <= col < cols):
            continue
        center_lon = min_lon + (col + 0.5) * cell_lon
        center_lat = min_lat + (row + 0.5) * cell_lat
        dist = meters(lon, lat, center_lon, center_lat)
        if dist < best_d[row, col]:
            best_d[row, col] = dist
            painted[row, col] = int(round(min(20.0, max(0.0, minutes)) * 10))
    if not np.any(painted != 255):
        raise SystemExit("drive-time grid has no road cells")
    mask = np.ones((rows, cols), dtype=np.uint8)
    mask[painted != 255] = 0
    dist, indices = distance_transform_edt(mask, return_indices=True, sampling=(CELL_M, CELL_M))
    result = painted.copy()
    take = (mask == 1) & (dist <= SEARCH_M)
    result[take] = painted[indices[0][take], indices[1][take]]
    return {
        "origin_lon": min_lon,
        "origin_lat": min_lat,
        "cell_lon": cell_lon,
        "cell_lat": cell_lat,
        "cols": cols,
        "rows": rows,
        "values": result,
    }


def grid_lookup(grid, lon: float, lat: float):
    col = int((lon - grid["origin_lon"]) / grid["cell_lon"])
    row = int((lat - grid["origin_lat"]) / grid["cell_lat"])
    values = grid["values"]
    if not (0 <= row < values.shape[0] and 0 <= col < values.shape[1]):
        return None
    value = int(values[row, col])
    if value == 255:
        return None
    return value / 10.0


def dump(path: Path, payload, pretty: bool = False) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + ".tmp")
    with temp.open("w") as handle:
        if pretty:
            json.dump(payload, handle, indent=2)
            handle.write("\n")
        else:
            json.dump(payload, handle, separators=(",", ":"))
    temp.replace(path)


def nearest_reached(time_of, node_ll, lon: float, lat: float, limit_m: float = 350):
    best = None
    for nid, seconds in time_of.items():
        if nid not in node_ll:
            continue
        nlon, nlat = node_ll[nid]
        if abs(nlon - lon) > 0.008 or abs(nlat - lat) > 0.008:
            continue
        dist = meters(lon, lat, nlon, nlat)
        if dist <= limit_m and (best is None or dist < best[0]):
            best = (dist, seconds / 60.0)
    return best


def main() -> None:
    parser = argparse.ArgumentParser(description="Build Kendall School drive-time data")
    parser.add_argument("--force", action="store_true", help="Rebuild the clipped OSM extract")
    parser.add_argument("--self-test-only", action="store_true")
    args = parser.parse_args()
    self_test()
    if args.self_test_only:
        return

    global HEAD_DEGREE
    west, south, east, north = bbox_from(REF_LAT, REF_LON, RADIUS_M)
    pbf = find_pbf()
    roads = ensure_roads(pbf, west, south, east, north, args.force)
    log("reading the road network")
    collector = Collector()
    collector.apply_file(str(roads), locations=True)
    log(
        f"roads {len(collector.ways):,}  nodes {len(collector.node_ll):,}  "
        f"rss {rss_mb():.0f} MB"
    )
    if not collector.school_ring or len(collector.school_ring) < 4:
        raise SystemExit(f"OSM way {SCHOOL_WAY_ID} was not in the extract")
    tags = collector.school_tags
    if "Kendall" not in tags.get("name", "") or tags.get("amenity") != "school":
        raise SystemExit(f"way {SCHOOL_WAY_ID} is not Kendall School: {tags}")
    if tags.get("addr:housenumber") != "577" or "Belmont" not in tags.get("addr:street", ""):
        raise SystemExit(f"school address changed: {tags}")
    school_lon, school_lat = interior_point(collector.school_ring)
    if not point_in_ring(school_lon, school_lat, collector.school_ring):
        raise SystemExit("school centroid falls outside the building footprint")
    if not point_in_ring(REF_LON, REF_LAT, collector.school_ring):
        raise SystemExit("reference coordinate is not on the school building")
    agree = meters(school_lon, school_lat, REF_LON, REF_LAT)
    if agree > 25:
        raise SystemExit(f"school centroid is {agree:.1f} m from the geocoded point")
    log(f"school {school_lat:.7f}, {school_lon:.7f}  ({agree:.1f} m from Nominatim, inside the building)")

    log("building the drive graph")
    best: dict[tuple[int, int], float] = {}
    for refs, speed, highway, can_f, can_b, _name in collector.ways:
        for i in range(len(refs) - 1):
            a = int(refs[i])
            b = int(refs[i + 1])
            la = collector.node_ll[a]
            lb = collector.node_ll[b]
            length = meters(la[0], la[1], lb[0], lb[1])
            if length < 0.4:
                continue
            seconds = travel_seconds(length, speed, highway)
            if can_f:
                add_min(best, a, b, seconds)
            if can_b:
                add_min(best, b, a, seconds)
    if INTERSECTION_DELAY_S > 0:
        neighbors: dict[int, set[int]] = {}
        for u, v in best:
            neighbors.setdefault(u, set()).add(v)
            neighbors.setdefault(v, set()).add(u)
        HEAD_DEGREE = {nid: len(ends) for nid, ends in neighbors.items()}
        for (u, v), seconds in list(best.items()):
            if HEAD_DEGREE.get(v, 0) >= 3:
                best[(u, v)] = seconds + INTERSECTION_DELAY_S
    else:
        HEAD_DEGREE = {}
    log(f"directed hops {len(best):,}")

    snap = None
    for wi in collector.near_ways:
        refs, speed, highway, can_f, can_b, name = collector.ways[wi]
        for hi in range(len(refs) - 1):
            a = int(refs[hi])
            b = int(refs[hi + 1])
            la = collector.node_ll[a]
            lb = collector.node_ll[b]
            dist, frac, px, py = project_point(school_lon, school_lat, la[0], la[1], lb[0], lb[1])
            if dist > 100:
                continue
            score = dist + (120 if highway in AVOID else 0)
            if snap is None or score < snap["score"]:
                snap = {
                    "way": wi,
                    "hop": hi,
                    "dist": dist,
                    "frac": frac,
                    "lon": px,
                    "lat": py,
                    "score": score,
                    "name": name,
                    "highway": highway,
                    "a": a,
                    "b": b,
                    "speed": speed,
                    "can_f": can_f,
                    "can_b": can_b,
                }
    if snap is None or snap["dist"] > 70:
        raise SystemExit(f"could not snap the school to a nearby street: {snap}")
    refs, speed, highway, can_f, can_b, _name = collector.ways[snap["way"]]
    a = snap["a"]
    b = snap["b"]
    la = collector.node_ll[a]
    lb = collector.node_ll[b]
    length = meters(la[0], la[1], lb[0], lb[1])
    full_drive = travel_seconds(length, speed, highway)
    delay_a = INTERSECTION_DELAY_S if HEAD_DEGREE.get(a, 0) >= 3 else 0.0
    delay_b = INTERSECTION_DELAY_S if HEAD_DEGREE.get(b, 0) >= 3 else 0.0
    frac = snap["frac"]
    if can_f:
        add_min(best, ORIGIN, b, (1 - frac) * full_drive + delay_b)
    if can_b:
        add_min(best, ORIGIN, a, frac * full_drive + delay_a)
    collector.node_ll[ORIGIN] = (snap["lon"], snap["lat"])
    snap["t_fn"] = make_snap_time(
        frac,
        full_drive,
        can_f,
        can_b,
        delay_a,
        delay_b,
        None,
        None,
    )
    # Upstream of a one-way is filled after Dijkstra, once node times exist.
    log(
        f"snapped to {snap['name'] or 'unnamed'} ({snap['highway']}) "
        f"{snap['dist']:.1f} m from the building"
    )

    log("routing")
    index: dict[int, int] = {}
    for u, v in best:
        if u not in index:
            index[u] = len(index)
        if v not in index:
            index[v] = len(index)
    count = len(index)
    rows = np.empty(len(best), dtype=np.int32)
    cols = np.empty(len(best), dtype=np.int32)
    data = np.empty(len(best), dtype=np.float64)
    for i, ((u, v), seconds) in enumerate(best.items()):
        rows[i] = index[u]
        cols[i] = index[v]
        data[i] = seconds
    graph = csr_matrix((data, (rows, cols)), shape=(count, count))
    del best, rows, cols, data
    gc.collect()
    dist = dijkstra(csgraph=graph, directed=True, indices=index[ORIGIN], limit=float(MAX_SECONDS))
    del graph
    time_of: dict[int, float] = {}
    for nid, i in index.items():
        seconds = float(dist[i])
        if math.isfinite(seconds) and seconds <= MAX_SECONDS + 1e-3:
            time_of[nid] = seconds
    del dist, index
    gc.collect()
    if time_of.get(ORIGIN, 1) > 1e-3:
        raise SystemExit("origin was not reached at time zero")
    max_reach = 0.0
    max_reach_t = 0.0
    for nid, seconds in time_of.items():
        if nid == ORIGIN:
            continue
        nlon, nlat = collector.node_ll[nid]
        dist_m = meters(school_lon, school_lat, nlon, nlat)
        if dist_m > max_reach:
            max_reach = dist_m
            max_reach_t = seconds
    log(
        f"reached {len(time_of):,} nodes  farthest {max_reach / 1000:.1f} km "
        f"at {max_reach_t / 60:.1f} min  rss {rss_mb():.0f} MB"
    )
    if max_reach > RADIUS_M - 2500:
        raise SystemExit(
            f"20-minute network reaches {max_reach / 1000:.1f} km, close to the "
            f"{RADIUS_M / 1000:.0f} km download. Increase RADIUS_M and rerun."
        )
    # One-way snap: upstream times need the settled node times.
    if not (can_f and can_b):
        snap["t_fn"] = make_snap_time(
            frac,
            full_drive,
            can_f,
            can_b,
            delay_a,
            delay_b,
            time_of.get(a),
            time_of.get(b),
        )

    log("drawing streets and the 20-minute grid")
    grid_samples_seed = [(school_lon, school_lat, 0.0), (snap["lon"], snap["lat"], 0.0)]
    buckets, band_km, band_bounds, grid_samples = render_ways(
        collector.ways, collector.node_ll, time_of, snap
    )
    grid_samples.extend(grid_samples_seed)
    log(
        "street km by band "
        + ", ".join(f"{band}:{band_km[band]:.0f}" for band in (1, 2, 3, 4))
    )
    grid = build_grid(grid_samples, school_lon, school_lat)
    school_minutes = grid_lookup(grid, school_lon, school_lat)
    log(f"grid {grid['cols']} x {grid['rows']}  school cell {school_minutes} min")

    failures = []
    if school_minutes is None or school_minutes > 1.5:
        failures.append(f"school grid time is {school_minutes}")
    else:
        row = int((school_lat - grid["origin_lat"]) / grid["cell_lat"])
        col = int((school_lon - grid["origin_lon"]) / grid["cell_lon"])
        grid["values"][row, col] = 0

    checks = [
        ("Belmont Town Hall", 42.3966362, -71.1772683, 1.0, 9.0),
        ("Harvard Square", 42.3734734, -71.1189431, 3.0, 16.0),
        ("Arlington Center", 42.4124649, -71.1485439, 4.0, 16.0),
        ("Lexington Battle Green", 42.4493035, -71.2307236, 6.0, 20.0),
        ("Waltham Common", 42.3753543, -71.2357090, 4.0, 16.0),
        ("Boston Common", 42.3550400, -71.0660710, 8.0, 22.0, True),
    ]
    check_rows = []
    for name, lat, lon, lo, hi, *rest in checks:
        offroad_ok = bool(rest and rest[0])
        minutes = grid_lookup(grid, lon, lat)
        node = nearest_reached(time_of, collector.node_ll, lon, lat)
        straight = meters(school_lon, school_lat, lon, lat) / 1000
        implied = None if not minutes else straight / (minutes / 60)
        check_rows.append(
            {
                "name": name,
                "gridMinutes": minutes,
                "nearestNodeMinutes": None if node is None else round(node[1], 2),
                "nearestNodeMeters": None if node is None else round(node[0], 1),
                "straightKm": round(straight, 2),
                "impliedKmh": None if implied is None else round(implied, 1),
            }
        )
        log(
            f"  {name}: grid {minutes} min  node {None if node is None else round(node[1], 1)} min  "
            f"straight {straight:.1f} km"
        )
        on_grid = minutes is not None and lo <= minutes <= hi
        near_road = node is not None and node[0] <= 400 and lo <= node[1] <= hi
        if not on_grid and not (offroad_ok and near_road):
            failures.append(f"{name} grid {minutes} min, expected {lo}–{hi}")
    worcester = grid_lookup(grid, -71.8023, 42.2626)
    if worcester is not None:
        failures.append(f"Worcester should be outside 20 minutes, got {worcester}")
    for band, minimum, maximum in ((1, 8, 4000), (2, 15, 6000), (3, 20, 8000), (4, 10, 9000)):
        if not minimum <= band_km[band] <= maximum:
            failures.append(f"band {band} length {band_km[band]:.1f} km looks wrong")
    if not 5_000 <= len(time_of) <= 1_500_000:
        failures.append(f"reached node count {len(time_of)} looks wrong")
    if failures:
        for failure in failures:
            log("FAIL " + failure)
        raise SystemExit(1)

    meta = {
        "school": {
            "name": "The Kendall School",
            "shortName": "Kendall School",
            "address": "577 Belmont Street, Belmont, MA",
            "street": "577 Belmont Street",
            "lat": school_lat,
            "lon": school_lon,
            "osmType": "way",
            "osmId": SCHOOL_WAY_ID,
        },
        "bands": BANDS,
        "unlit": {"band": 4, "label": "15–20 min", "minSec": 900, "maxSec": 1200},
        "bounds": {
            "5": union_bounds([band_bounds[1]], school_lon, school_lat),
            "10": union_bounds([band_bounds[1], band_bounds[2]], school_lon, school_lat),
            "15": union_bounds([band_bounds[1], band_bounds[2], band_bounds[3]], school_lon, school_lat),
            "20": union_bounds(list(band_bounds.values()), school_lon, school_lat),
        },
        "note": NOTE,
    }
    visible = features_from(buckets, {1, 2, 3})
    outer = features_from(buckets, {4})
    raw = grid["values"].astype(np.uint8).tobytes(order="C")
    grid_json = {
        "version": 1,
        "maxMinutes": 20,
        "nullValue": 255,
        "tenths": True,
        "originLon": grid["origin_lon"],
        "originLat": grid["origin_lat"],
        "cellLon": grid["cell_lon"],
        "cellLat": grid["cell_lat"],
        "cols": grid["cols"],
        "rows": grid["rows"],
        "searchMeters": SEARCH_M,
        "values": base64.b64encode(raw).decode("ascii"),
    }
    method = {
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "summary": (
            "Free-flow drive time is street length divided by speed. Speed is the OSM "
            "maxspeed tag when present, otherwise the highway-class default in FREEFLOW_MPH. "
            "Times are one-way aware. Intersection delay and congestion are not included."
        ),
        "anchor": {
            "osm": f"way/{SCHOOL_WAY_ID}",
            "name": tags.get("name"),
            "housenumber": tags.get("addr:housenumber"),
            "street": tags.get("addr:street"),
            "centroid": [school_lon, school_lat],
            "insideFootprint": True,
            "nominatimMeters": round(agree, 2),
            "snap": {
                "street": snap["name"],
                "highway": snap["highway"],
                "distanceMeters": round(snap["dist"], 2),
                "lon": snap["lon"],
                "lat": snap["lat"],
            },
        },
        "formula": "seconds = (length_m / speed_mps) * RUSH_FACTOR[highway] * GLOBAL_RUSH_MULTIPLIER + intersection_delay",
        "freeFlowMph": FREEFLOW_MPH,
        "rushFactor": RUSH_FACTOR,
        "globalRushMultiplier": GLOBAL_RUSH_MULTIPLIER,
        "intersectionDelaySeconds": INTERSECTION_DELAY_S,
        "excluded": [
            "service roads and parking aisles",
            "foot, cycle, and path ways",
            "access=no and motor_vehicle=no",
        ],
        "searchRadiusMeters": RADIUS_M,
        "bbox": [west, south, east, north],
        "maxReachMeters": round(max_reach, 1),
        "maxReachMinutes": round(max_reach_t / 60, 2),
        "clipped": False,
        "reachedNodes": len(time_of),
        "ways": len(collector.ways),
        "maxspeedWays": collector.maxspeed_used,
        "defaultSpeedWays": collector.default_used,
        "highwayCounts": dict(collector.highways),
        "lengthKm": {str(band): round(band_km[band], 1) for band in band_km},
        "bucketSeconds": BUCKET_S,
        "simplifyMeters": SIMPLIFY_M,
        "grid": {
            "cellMeters": CELL_M,
            "searchMeters": SEARCH_M,
            "cols": grid["cols"],
            "rows": grid["rows"],
            "encoding": "row-major uint8, minutes*10, 255 = outside 20 min or away from a reached road",
        },
        "source": PBF_URL,
        "checks": check_rows,
    }
    dump(OUT / "meta.json", meta, pretty=True)
    dump(OUT / "method.json", method, pretty=True)
    dump(OUT / "streets.geojson", visible)
    dump(OUT / "streets-15-20.geojson", outer)
    dump(OUT / "travel-grid.json", grid_json)
    for name in ("streets.geojson", "streets-15-20.geojson", "travel-grid.json"):
        size = (OUT / name).stat().st_size
        log(f"wrote {name}  {size / 1e6:.2f} MB")
    subprocess.check_call([sys.executable, str(Path(__file__).with_name("pack_streets.py"))])
    log("done")


if __name__ == "__main__":
    try:
        main()
    except subprocess.CalledProcessError as exc:
        raise SystemExit(f"osmium failed with status {exc.returncode}") from exc
