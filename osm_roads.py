# osm_roads.py (FULL replacement)
import math
import requests
import json
import time
from typing import List, Dict, Tuple

OVERPASS_URL = "https://overpass-api.de/api/interpreter"
CACHE_FILE = "roads_cache.json"


def _haversine(a: List[float], b: List[float]) -> float:
    # a,b = [lat,lon]
    R = 6371000.0
    lat1, lon1 = math.radians(a[0]), math.radians(a[1])
    lat2, lon2 = math.radians(b[0]), math.radians(b[1])
    dlat = lat2 - lat1
    dlon = lon2 - lon1
    s = math.sin(dlat / 2.0) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2.0) ** 2
    return 2 * R * math.asin(min(1.0, math.sqrt(s)))


def _poly_length(coords: List[List[float]]) -> float:
    if not coords or len(coords) < 2:
        return 0.0
    total = 0.0
    for i in range(1, len(coords)):
        total += _haversine(coords[i - 1], coords[i])
    return total


def _centroid_of_poly(coords: List[List[float]]) -> Tuple[float, float]:
    lats = [p[0] for p in coords]
    lons = [p[1] for p in coords]
    return (sum(lats) / len(lats), sum(lons) / len(lons))


def _segment_bearing(a: List[float], b: List[float]) -> float:
    # returns initial bearing (degrees 0..360) from a to b
    lat1 = math.radians(a[0]); lat2 = math.radians(b[0])
    dlon = math.radians(b[1] - a[1])
    x = math.sin(dlon) * math.cos(lat2)
    y = math.cos(lat1) * math.sin(lat2) - math.sin(lat1) * math.cos(lat2) * math.cos(dlon)
    br = math.degrees(math.atan2(x, y))
    return (br + 360) % 360


def _angle_diff(a_deg: float, b_deg: float) -> float:
    d = abs(a_deg - b_deg) % 360
    return min(d, 360 - d)


def _order_coords_if_needed(coords: List[List[float]]) -> List[List[float]]:
    """
    Prefer to keep coords as-is (Overpass usually gives ordered geometry).
    If internal largest adjacent gap is huge (indicating badly ordered points),
    perform a small local nearest-neighbor re-order (only within that fragment).
    """
    if len(coords) < 3:
        return coords[:]
    gaps = [_haversine(coords[i], coords[i + 1]) for i in range(len(coords) - 1)]
    max_gap = max(gaps)
    avg_gap = sum(gaps) / len(gaps)
    if max_gap < max(200, 5 * avg_gap):  # threshold: 200m absolute or 5x avg
        return coords[:]
    pts = coords[:]
    ordered = [pts.pop(0)]
    while pts:
        last = ordered[-1]
        nearest_idx = min(range(len(pts)), key=lambda i: _haversine(last, pts[i]))
        ordered.append(pts.pop(nearest_idx))
    return ordered


def _stitch_fragments_safe(
    fragments: List[List[List[float]]],
    stitch_thresh_m: float = 40.0,
    angle_thresh_deg: float = 35.0,
    cluster_thresh_m: float = 1000.0,
) -> List[List[List[float]]]:
    """
    - Cluster fragments by centroid proximity so fragments far apart are not considered together.
    - Within each cluster, only stitch fragments whose endpoints are within stitch_thresh_m
      AND whose bearings align within angle_thresh_deg.
    - Returns list of stitched polylines (one or many).
    """
    if not fragments:
        return []

    centroids = [_centroid_of_poly(f) for f in fragments]
    clusters: List[List[int]] = []
    for i, c in enumerate(centroids):
        placed = False
        for cl in clusters:
            rep = centroids[cl[0]]
            if _haversine(c, rep) <= cluster_thresh_m:
                cl.append(i)
                placed = True
                break
        if not placed:
            clusters.append([i])

    stitched_all: List[List[List[float]]] = []
    for cl in clusters:
        idxs = cl[:]
        frags = [fragments[i] for i in idxs]
        used = [False] * len(frags)
        for i in range(len(frags)):
            if used[i]:
                continue
            base = _order_coords_if_needed(frags[i][:])  # prefer original order
            used[i] = True
            made_progress = True
            while made_progress:
                made_progress = False
                for j in range(len(frags)):
                    if used[j]:
                        continue
                    cand = _order_coords_if_needed(frags[j][:])
                    combos = [
                        (base[-1], cand[0], "append", False),
                        (base[-1], cand[-1], "append", True),
                        (base[0], cand[-1], "prepend", False),
                        (base[0], cand[0], "prepend", True),
                    ]
                    best = None
                    for a_pt, b_pt, op, rev in combos:
                        d = _haversine(a_pt, b_pt)
                        if d > stitch_thresh_m:
                            continue
                        if op == "append":
                            base_bear = _segment_bearing(base[-2], base[-1]) if len(base) >= 2 else _segment_bearing(base[0], base[-1])
                            if rev:
                                cand_bear = _segment_bearing(cand[-1], cand[-2]) if len(cand) >= 2 else _segment_bearing(cand[-1], cand[0])
                            else:
                                cand_bear = _segment_bearing(cand[0], cand[1]) if len(cand) >= 2 else _segment_bearing(cand[0], cand[-1])
                        else:
                            base_bear = _segment_bearing(base[1], base[0]) if len(base) >= 2 else _segment_bearing(base[0], base[-1])
                            if rev:
                                cand_bear = _segment_bearing(cand[-1], cand[-2]) if len(cand) >= 2 else _segment_bearing(cand[-1], cand[0])
                            else:
                                cand_bear = _segment_bearing(cand[0], cand[1]) if len(cand) >= 2 else _segment_bearing(cand[0], cand[-1])
                        ang_diff = _angle_diff(base_bear, cand_bear)
                        if ang_diff <= angle_thresh_deg:
                            best = (j, op, rev, d, ang_diff)
                            break
                    if best:
                        j_idx, op, rev, _, _ = best
                        frag_coords = frags[j_idx][:]
                        if rev:
                            frag_coords = list(reversed(frag_coords))
                        if op == "append":
                            if _haversine(base[-1], frag_coords[0]) < 1e-6:
                                base = base + frag_coords[1:]
                            else:
                                base = base + frag_coords
                        else:
                            if _haversine(base[0], frag_coords[-1]) < 1e-6:
                                base = frag_coords[:-1] + base
                            else:
                                base = frag_coords + base
                        used[j_idx] = True
                        made_progress = True
            stitched_all.append(base)
    return stitched_all


def _bbox_for_city_with_expand(city: str, expand_deg: float = 0.0) -> Tuple[float, float, float, float]:
    """
    Uses Nominatim to get boundingbox, then expands by expand_deg degrees on each side.
    """
    try:
        r = requests.get(
            "https://nominatim.openstreetmap.org/search",
            params={"q": city, "format": "json", "limit": 1},
            headers={"User-Agent": "margdarshak/1.0"},
            timeout=10,
        )
        j = r.json()
        if not j:
            s, w, n, e = 18.85, 72.65, 19.35, 73.1
        else:
            bb = j[0]["boundingbox"]
            s = float(bb[0]); n = float(bb[1]); w = float(bb[2]); e = float(bb[3])
    except Exception:
        s, w, n, e = 18.85, 72.65, 19.35, 73.1
    return (s - expand_deg, w - expand_deg, n + expand_deg, e + expand_deg)


def _split_polyline_evenly(coords: List[List[float]], parts: int) -> List[List[List[float]]]:
    """
    Split a polyline (coords) into `parts` contiguous pieces by arc-length.
    """
    if parts <= 1 or len(coords) < 2:
        return [coords]
    total_len = _poly_length(coords)
    if total_len == 0:
        return [coords]

    # distances between consecutive points
    seg_lens = [_haversine(coords[i - 1], coords[i]) for i in range(1, len(coords))]
    cum = [0.0]
    for l in seg_lens:
        cum.append(cum[-1] + l)

    targets = [i * total_len / parts for i in range(parts)]
    pieces: List[List[List[float]]] = []
    for t in targets:
        # find index where cum[k] <= t <= cum[k+1]
        k = 0
        while k < len(cum) - 1 and cum[k + 1] < t:
            k += 1
        # build a small piece around that area: include neighboring points for continuity
        start_i = max(0, k - 1)
        end_i = min(len(coords) - 1, k + 2)
        piece = []
        for i in range(start_i, end_i + 1):
            piece.append(coords[i])
        if len(piece) < 2:
            piece = [coords[0], coords[-1]]
        pieces.append(piece)
    # ensure uniqueness of pieces and min length
    normalized: List[List[List[float]]] = []
    for p in pieces:
        if len(p) < 2:
            normalized.append([coords[0], coords[-1]])
        else:
            normalized.append(p)
    return normalized


def get_roads_for_city(city: str, max_roads: int = 200, target_segments: int = None, use_cache: bool = True) -> List[Dict]:
    """
    - Expands bbox until we collect enough named roads (up to a limit).
    - Groups OSM 'ways' by name/ref, clusters fragments spatially, stitches only safe neighbors.
    - Returns list of road objects {id,name,coordinates,length_m}
    """
    if target_segments is None:
        target_segments = max_roads

    # Try cache first (best-effort)
    if use_cache:
        try:
            with open(CACHE_FILE, "r", encoding="utf-8") as f:
                cache = json.load(f)
            if cache.get("city", "").lower() == city.lower():
                cached = cache.get("roads", [])[:max_roads]
                for r in cached:
                    if "length_m" not in r:
                        r["length_m"] = _poly_length(r.get("coordinates", []))
                # if cache has enough, return immediately (cache may be stale but OK)
                if len(cached) >= min(max_roads, target_segments):
                    return cached[:max_roads]
        except Exception:
            pass

    expand_step = 0.01  # ~1km-ish per step
    max_expand = 0.10   # don't expand endlessly (> ~10km each side)
    expand = 0.0
    all_roads: List[Dict] = []

    while expand <= max_expand:
        south, west, north, east = _bbox_for_city_with_expand(city, expand_deg=expand)
        query = f"""
        [out:json][timeout:30];
        (
          way["highway"~"motorway|trunk|primary|secondary|tertiary|residential|unclassified|service"]({south},{west},{north},{east});
        );
        out geom;
        """
        raw = []
        try:
            resp = requests.post(OVERPASS_URL, data=query.encode("utf-8"), headers={"User-Agent": "margdarshak/1.0"}, timeout=60)
            j = resp.json()
            for e in j.get("elements", []):
                if e.get("type") != "way":
                    continue
                name = e.get("tags", {}).get("name") or e.get("tags", {}).get("ref") or f"unnamed_{e.get('id')}"
                coords = []
                for g in e.get("geometry", []):
                    coords.append([g["lat"], g["lon"]])
                if len(coords) < 2:
                    continue
                raw.append({"id": f"way_{e.get('id')}", "name": name, "coordinates": coords})
        except Exception:
            raw = []

        # If we got nothing from Overpass, fallback to synthetic grid (small)
        if not raw:
            # fallback synthetic
            lat_span = north - south
            lon_span = east - west
            num_lines = max(2, int((max_roads / 4) ** 0.5))
            num_points = 6
            cnt = 0
            synthetic: List[Dict] = []
            for i in range(num_lines):
                if cnt >= max_roads:
                    break
                lat = south + (i + 1) * (lat_span / (num_lines + 1))
                coords = []
                for k in range(num_points):
                    lon = west + (lon_span * k) / (num_points - 1)
                    coords.append([lat, lon])
                synthetic.append({"id": f"synthetic_H_{cnt}", "name": f"Synthetic H Road {i}", "coordinates": coords})
                cnt += 1
            for j in range(num_lines):
                if cnt >= max_roads:
                    break
                lon = west + (j + 1) * (lon_span / (num_lines + 1))
                coords = []
                for k in range(num_points):
                    lat = south + (lat_span * k) / (num_points - 1)
                    coords.append([lat, lon])
                synthetic.append({"id": f"synthetic_V_{cnt}", "name": f"Synthetic V Road {j}", "coordinates": coords})
                cnt += 1
            raw = synthetic

        # group fragments by name/ref
        groups: Dict[str, List[List[List[float]]]] = {}
        for node in raw:
            groups.setdefault(node["name"], []).append(node["coordinates"])

        merged: List[Dict] = []
        for name, frags in groups.items():
            # stitch safely
            stitched_polys = _stitch_fragments_safe(frags,
                                                   stitch_thresh_m=60.0,
                                                   angle_thresh_deg=35.0,
                                                   cluster_thresh_m=2000.0)
            for idx, poly in enumerate(stitched_polys):
                if len(poly) < 2:
                    continue
                merged.append({
                    "id": f"merged_{(name[:30] if name else 'unnamed')}_{idx}",
                    "name": name,
                    "coordinates": poly,
                    "length_m": _poly_length(poly)
                })

        merged = sorted(merged, key=lambda x: x["length_m"], reverse=True)
        all_roads = merged

        # if we have enough roads (at least target_segments) break
        if len(all_roads) >= max(1, target_segments) or expand >= max_expand:
            break
        expand += expand_step

    # if fewer roads than requested, we can split long roads to reach target_segments
    result: List[Dict] = []
    curr_count = 0
    for r in all_roads:
        if curr_count >= target_segments:
            break
        remaining_needed = target_segments - curr_count
        parts = 1
        if remaining_needed > 0 and r["length_m"] > 2000 and remaining_needed > 1:
            est = int(min(remaining_needed, max(1, round(r["length_m"] / 2000))))
            parts = max(1, est)
        pieces = _split_polyline_evenly(r["coordinates"], parts)
        for i, p in enumerate(pieces):
            if curr_count >= target_segments:
                break
            seg = {
                "id": f"{r['id']}_part_{i}",
                "name": r["name"],
                "coordinates": p,
                "length_m": _poly_length(p)
            }
            result.append(seg)
            curr_count += 1

    # if still short, append remaining roads until target reached
    if curr_count < target_segments:
        for r in all_roads:
            if curr_count >= target_segments:
                break
            if any(x["id"].startswith(r["id"]) for x in result):
                continue
            result.append(r)
            curr_count += 1

    # final trim by max_roads
    if len(result) > max_roads:
        result = sorted(result, key=lambda x: x.get("length_m", 0), reverse=True)[:max_roads]

    # cache best-effort
    try:
        lats = [pt[0] for r in result for pt in r["coordinates"]]
        lons = [pt[1] for r in result for pt in r["coordinates"]]
        cache_obj = {"city": city, "roads": result}
        if lats and lons:
            cache_obj["bbox"] = [min(lats), min(lons), max(lats), max(lons)]
        with open(CACHE_FILE, "w", encoding="utf-8") as f:
            json.dump(cache_obj, f, ensure_ascii=False)
    except Exception:
        pass

    return result[:max_roads]


# If run as a quick tester
if __name__ == "__main__":
    import sys
    city = sys.argv[1] if len(sys.argv) > 1 else "Mumbai"
    roads = get_roads_for_city(city, max_roads=120, target_segments=50)
    print(f"Got {len(roads)} roads; sample:")
    for i, r in enumerate(roads[:5]):
        print(i + 1, r["id"], r["name"], "len_m=", round(r["length_m"], 1), "pts=", len(r["coordinates"]))
