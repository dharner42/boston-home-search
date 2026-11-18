#!/usr/bin/env python3
"""Pack a routable Greater Boston graph for traffic-aware drive times.

The graph is the drivable OpenStreetMap network within 42 km of The Kendall
School: one-ways, posted maxspeed when present, and geometry simplified to
about 6 m. Edges run intersection-to-intersection. Travel time on an edge is
free-flow (length / speed) with no signals and no congestion. The live server
scales those times to a Tuesday 8:00 departure.

Output: server/graph.bin
"""

from __future__ import annotations

import heapq
import math
import struct
import sys
from array import array
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

from generate_drive_times import (  # noqa: E402
    CACHE,
    FREEFLOW_MPH,
    M_PER_DEG_LAT,
    M_PER_DEG_LON,
    RADIUS_M,
    REF_LAT,
    REF_LON,
    Collector,
    bbox_from,
    douglas_peucker,
    ensure_roads,
    find_pbf,
    log,
    meters,
    parse_directions,
    travel_seconds,
)

OUT = ROOT / "server" / "graph.bin"

CLASS_ID = {
    "motorway": 0,
    "motorway_link": 1,
    "trunk": 2,
    "trunk_link": 3,
    "primary": 4,
    "primary_link": 5,
    "secondary": 6,
    "secondary_link": 7,
    "tertiary": 8,
    "tertiary_link": 9,
    "unclassified": 10,
    "residential": 11,
    "living_street": 12,
}

CHECKS = [
    ("Harvard Square", 42.3734734, -71.1189431, 6.5),
    ("Arlington Center", 42.4124649, -71.1485439, 7.1),
    ("Waltham Common", 42.3753543, -71.2357090, 6.4),
    ("Lexington Center", 42.4493035, -71.2307236, 13.1),
    ("Boston Common", 42.3550400, -71.0660710, 13.4),
]


def main() -> None:
    west, south, east, north = bbox_from(REF_LAT, REF_LON, RADIUS_M)
    pbf = find_pbf()
    roads = ensure_roads(pbf, west, south, east, north, False)
    log("reading roads")
    collector = Collector()
    collector.apply_file(str(roads), locations=True)
    log(f"ways {len(collector.ways):,}  shape nodes {len(collector.node_ll):,}")

    usage: Counter[int] = Counter()
    endpoints: set[int] = set()
    for refs, _speed, _highway, _can_f, _can_b, _name in collector.ways:
        if not refs:
            continue
        endpoints.add(int(refs[0]))
        endpoints.add(int(refs[-1]))
        for ref in refs:
            usage[int(ref)] += 1
    keep = {node for node, count in usage.items() if count >= 2 or node in endpoints}
    log(f"intersections {len(keep):,}")

    # Directed edge key -> (seconds, class, geometry lon/lat)
    best: dict[tuple[int, int], tuple[float, int, list[list[float]]]] = {}
    for refs, speed, highway, can_f, can_b, _name in collector.ways:
        coords = [(int(ref), collector.node_ll[int(ref)][0], collector.node_ll[int(ref)][1]) for ref in refs]
        span: list[tuple[int, float, float]] = [coords[0]]
        pieces: list[list[tuple[int, float, float]]] = []
        for point in coords[1:]:
            span.append(point)
            if point[0] in keep and len(span) >= 2:
                pieces.append(span)
                span = [point]
        if len(span) >= 2:
            pieces.append(span)
        for piece in pieces:
            emit(best, piece, float(speed), str(highway), bool(can_f), bool(can_b))

    nodes = sorted({node for pair in best for node in pair})
    index = {node: i for i, node in enumerate(nodes)}
    log(f"graph nodes {len(nodes):,}  directed edges {len(best):,}")

    outgoing: dict[int, list[tuple[int, float]]] = defaultdict(list)
    lons = [collector.node_ll[node][0] for node in nodes]
    lats = [collector.node_ll[node][1] for node in nodes]
    min_lon, max_lon = min(lons), max(lons)
    min_lat, max_lat = min(lats), max(lats)
    pad = 1e-4
    origin_lon = min_lon - pad
    origin_lat = min_lat - pad
    span_lon = (max_lon - min_lon) + 2 * pad
    span_lat = (max_lat - min_lat) + 2 * pad

    def q(lon: float, lat: float) -> tuple[int, int]:
        x = int(round((lon - origin_lon) / span_lon * 65535))
        y = int(round((lat - origin_lat) / span_lat * 65535))
        return max(0, min(65535, x)), max(0, min(65535, y))

    edges_of: list[list[tuple[int, int, int, list[tuple[int, int]]]]] = [[] for _ in nodes]
    for (u, v), (seconds, cls, geom) in best.items():
        ui, vi = index[u], index[v]
        pts = [q(lon, lat) for lon, lat in geom]
        compact = [pts[0]]
        for pt in pts[1:]:
            if pt != compact[-1]:
                compact.append(pt)
        if len(compact) < 2:
            compact = [q(lons[ui], lats[ui]), q(lons[vi], lats[vi])]
        ff = int(round(seconds))
        ff = max(1, min(65535, ff))
        edges_of[ui].append((vi, ff, cls, compact))
        outgoing[ui].append((vi, float(ff)))

    order = sorted(range(len(nodes)), key=lambda i: (lats[i], lons[i]))
    # Keep file order identical to `nodes` (osm-id sorted) so indexes stay stable.
    offsets = [0]
    flat: list[tuple[int, int, int, list[tuple[int, int]]]] = []
    for bucket in edges_of:
        flat.extend(bucket)
        offsets.append(len(flat))
    geom: list[tuple[int, int]] = []
    packed = []
    for to, ff, cls, pts in flat:
        start = len(geom)
        geom.extend(pts)
        packed.append((to, ff, cls, start, len(pts)))

    OUT.parent.mkdir(parents=True, exist_ok=True)
    blob = bytearray()
    blob += b"GRF1"
    blob += struct.pack(
        "<B4fIII",
        1,
        origin_lon,
        origin_lat,
        span_lon,
        span_lat,
        len(nodes),
        len(packed),
        len(geom),
    )
    node_buf = bytearray()
    for lon, lat in zip(lons, lats, strict=True):
        node_buf += struct.pack("<ii", int(round(lon * 1e7)), int(round(lat * 1e7)))
    blob += node_buf
    blob += struct.pack(f"<{len(offsets)}I", *offsets)
    edge_buf = bytearray()
    for to, ff, cls, start, count in packed:
        edge_buf += struct.pack("<IHBBIH", to, ff, cls, 0, start, count)
    blob += edge_buf
    geom_buf = bytearray()
    for x, y in geom:
        geom_buf += struct.pack("<HH", x, y)
    blob += geom_buf
    OUT.write_bytes(blob)
    log(f"wrote {OUT}  {len(blob) / 1e6:.2f} MB  geom points {len(geom):,}")

    snap = nearest_node(lons, lats, REF_LON, REF_LAT)
    log(f"school snap node {snap}  {meters(REF_LON, REF_LAT, lons[snap], lats[snap]):.1f} m")
    dist = dijkstra(outgoing, snap, limit=20 * 60)
    failures = []
    for name, lat, lon, expected in CHECKS:
        target = nearest_node(lons, lats, lon, lat)
        away = meters(lon, lat, lons[target], lats[target])
        seconds = dist.get(target)
        minutes = None if seconds is None else seconds / 60
        log(f"  {name}: free-flow {None if minutes is None else round(minutes, 2)} min  snap {away:.0f} m  (old {expected})")
        if minutes is None or abs(minutes - expected) > 2.5:
            failures.append(f"{name} {minutes} vs {expected}")
    if failures:
        raise SystemExit("graph check failed: " + "; ".join(failures))
    log("free-flow checks passed")
    # Silence unused import if a refactor drops parse_directions.
    assert parse_directions and CACHE and order is not None


def emit(
    best: dict[tuple[int, int], tuple[float, int, list[list[float]]]],
    piece: list[tuple[int, float, float]],
    speed: float,
    highway: str,
    can_f: bool,
    can_b: bool,
) -> None:
    if highway not in CLASS_ID or len(piece) < 2:
        return
    coords = [[lon, lat] for _ref, lon, lat in piece]
    length = 0.0
    for i in range(len(coords) - 1):
        length += meters(coords[i][0], coords[i][1], coords[i + 1][0], coords[i + 1][1])
    if length < 0.8:
        return
    seconds = travel_seconds(length, speed, highway)
    if not math.isfinite(seconds) or seconds <= 0:
        return
    simplified = douglas_peucker(coords, 6.0)
    simplified[0] = [coords[0][0], coords[0][1]]
    simplified[-1] = [coords[-1][0], coords[-1][1]]
    cls = CLASS_ID[highway]
    u, v = piece[0][0], piece[-1][0]
    if u == v:
        return
    if can_f:
        consider(best, u, v, seconds, cls, simplified)
    if can_b:
        consider(best, v, u, seconds, cls, list(reversed(simplified)))


def consider(
    best: dict[tuple[int, int], tuple[float, int, list[list[float]]]],
    u: int,
    v: int,
    seconds: float,
    cls: int,
    geom: list[list[float]],
) -> None:
    prev = best.get((u, v))
    if prev is None or seconds < prev[0]:
        best[(u, v)] = (seconds, cls, geom)


def nearest_node(lons: list[float], lats: list[float], lon: float, lat: float) -> int:
    best_i = 0
    best_d = 1e18
    # Coarse reject, then exact. A full scan of ~150k nodes is fine once.
    for i, (nlo, nla) in enumerate(zip(lons, lats, strict=True)):
        if abs(nlo - lon) > 0.02 or abs(nla - lat) > 0.02:
            continue
        dist = (nlo - lon) ** 2 + (nla - lat) ** 2
        if dist < best_d:
            best_d = dist
            best_i = i
    return best_i


def dijkstra(outgoing: dict[int, list[tuple[int, float]]], source: int, limit: float) -> dict[int, float]:
    dist: dict[int, float] = {source: 0.0}
    heap = [(0.0, source)]
    while heap:
        time, node = heapq.heappop(heap)
        if time > dist.get(node, 1e18):
            continue
        if time > limit:
            continue
        for nxt, cost in outgoing.get(node, ()):
            alt = time + cost
            if alt <= limit and alt < dist.get(nxt, 1e18):
                dist[nxt] = alt
                heapq.heappush(heap, (alt, nxt))
    return dist


if __name__ == "__main__":
    main()
