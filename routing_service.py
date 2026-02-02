# routing_service.py  (HARDENED + GRAPHOPPER PRIMARY + DUAL-PROVIDER RACING + ORS fallback)
# Replaces Mapbox/OSM-only flows by using GraphHopper (configurable via GH_API_KEY).
# Falls back to OSRM and OpenRouteService where available; still keeps snapping fallback.
import os
import time
import math
import logging
import threading
from typing import Tuple, Dict, Any, List
import requests
from functools import lru_cache
from queue import Queue, Empty

logger = logging.getLogger("routing_service")

# Primary provider: GraphHopper (requires GH_API_KEY env var)
GH_API_KEY = "4ba09369-2289-4a9b-a387-9d90d5d62cec"
GH_BASE_URL = os.environ.get("GH_BASE_URL", "https://graphhopper.com/api/1/route").rstrip("/")

# Secondary providers (optional)
OSRM_BASE_URL = os.environ.get("OSRM_URL", "https://router.project-osrm.org").rstrip("/")
ORS_API_KEY = "eyJvcmciOiI1YjNjZTM1OTc4NTExMTAwMDFjZjYyNDgiLCJpZCI6ImRiYjAxMDEwOWFkNDQ3OWRiMDAzZGUwMzg5OWQ3N2Q4IiwiaCI6Im11cm11cjY0In0="  # optional
ORS_BASE_URL = os.environ.get("ORS_BASE_URL", "https://api.openrouteservice.org").rstrip("/")

# optional osm_roads snapping helper
try:
    from osm_roads import get_roads_for_city
    _HAS_OSM_ROADS = True
except Exception:
    _HAS_OSM_ROADS = False

@lru_cache(maxsize=512)
def _cache_key(o_lat, o_lon, d_lat, d_lon, extras=""):
    return f"{o_lat:.6f},{o_lon:.6f}->{d_lat:.6f},{d_lon:.6f}|{extras}"

def _is_valid_coord_pair(lat, lon) -> bool:
    try:
        a = float(lat); b = float(lon)
        if a == 0.0 and b == 0.0:
            return False
        return -90.0 <= a <= 90.0 and -180.0 <= b <= 180.0
    except Exception:
        return False

def _haversine_m(a: Tuple[float,float], b: Tuple[float,float]) -> float:
    R = 6371000.0
    lat1, lon1 = math.radians(a[0]), math.radians(a[1])
    lat2, lon2 = math.radians(b[0]), math.radians(b[1])
    dlat = lat2 - lat1
    dlon = lon2 - lon1
    s = math.sin(dlat/2)**2 + math.cos(lat1)*math.cos(lat2)*math.sin(dlon/2)**2
    return 2 * R * math.asin(min(1.0, math.sqrt(s)))

def _interpolate_line_points(a: Tuple[float,float], b: Tuple[float,float], n:int=20) -> List[Tuple[float,float]]:
    if n < 2:
        return [a, b]
    pts = []
    for i in range(n):
        t = i/(n-1)
        lat = a[0] + (b[0]-a[0]) * t
        lon = a[1] + (b[1]-a[1]) * t
        pts.append((lat, lon))
    return pts

def _coords_lonlat_to_path(coords_lonlat: List[List[float]]) -> List[Dict[str,float]]:
    # coords are [[lon, lat], ...] -> path [{"lat":..., "lon":...}, ...]
    return [{"lat": float(lat), "lon": float(lon)} for (lon, lat) in coords_lonlat]

#
# GraphHopper call
#
def _call_graphhopper_route(o_lat, o_lon, d_lat, d_lon, timeout=6, alternatives: bool = False):
    if not GH_API_KEY:
        raise RuntimeError("GH_API_KEY not configured")
    params = {
        "point": [f"{o_lat},{o_lon}", f"{d_lat},{d_lon}"],
        "vehicle": "car",
        "points_encoded": "false",  # get coordinates array
        "locale": "en",
        "key": GH_API_KEY,
    }
    # GraphHopper alternative routes options are limited in free tier; keep single path normally
    # Use GET with repeated point params
    try:
        # build URL with repeated point params
        url = GH_BASE_URL
        # requests will encode list params if passed as list
        resp = requests.get(url, params=params, timeout=timeout)
        if resp.status_code == 429 or resp.status_code >= 500:
            raise RuntimeError(f"GraphHopper upstream status {resp.status_code}")
        resp.raise_for_status()
        data = resp.json()
        if not isinstance(data, dict) or not data.get("paths"):
            raise RuntimeError("GraphHopper returned invalid payload")
        return data
    except requests.RequestException as e:
        raise RuntimeError(f"GraphHopper request failed: {e}")

#
# OSRM and ORS (kept as fallbacks)
#
def _call_osrm_route(o_lat, o_lon, d_lat, d_lon, timeout=6, retries=1, alternatives: bool = True):
    url = f"{OSRM_BASE_URL}/route/v1/driving/{o_lon},{o_lat};{d_lon},{d_lat}"
    params = {
        "overview": "full",
        "geometries": "geojson",
        "steps": "false",
        "alternatives": "true" if alternatives else "false",
    }
    backoff = 0.3
    last_exc = None
    for attempt in range(1, retries + 2):
        try:
            resp = requests.get(url, params=params, timeout=timeout)
            if resp.status_code == 429 or resp.status_code >= 500:
                last_exc = RuntimeError(f"Upstream status {resp.status_code}")
                time.sleep(backoff); backoff *= 2.0
                continue
            resp.raise_for_status()
            data = resp.json()
            if not isinstance(data, dict) or data.get("code") != "Ok" or not data.get("routes"):
                last_exc = RuntimeError("OSRM invalid payload")
                time.sleep(backoff); backoff *= 2.0
                continue
            return data
        except requests.RequestException as e:
            last_exc = e
            time.sleep(backoff); backoff *= 2.0
    raise RuntimeError(f"OSRM call failed: {last_exc}")

def _call_ors_route(o_lat, o_lon, d_lat, d_lon, timeout=6, alternatives: bool = False):
    if not ORS_API_KEY:
        raise RuntimeError("ORS_API_KEY not configured")
    url = f"{ORS_BASE_URL}/v2/directions/driving-car/geojson"
    headers = {"Authorization": ORS_API_KEY, "Accept": "application/json"}
    body = {
        "coordinates": [[o_lon, o_lat], [d_lon, d_lat]],
        "instructions": False,
        "alternative_routes": {"share_factor": 0.6, "target_count": 2} if alternatives else None
    }
    json_body = {k:v for k,v in body.items() if v is not None}
    resp = requests.post(url, json=json_body, headers=headers, timeout=timeout)
    if resp.status_code == 429 or resp.status_code >= 500:
        raise RuntimeError(f"ORS returned {resp.status_code}")
    resp.raise_for_status()
    data = resp.json()
    if not isinstance(data, dict) or not data.get("features"):
        raise RuntimeError("ORS returned invalid payload")
    return data

#
# Snapping fallback (if osm_roads available)
#
def _snap_samples_to_nearest_road_points(origin, dest, city_hint: str="Mumbai", sample_points:int=30, max_snap_m:float=400.0) -> List[Dict[str,float]]:
    if not _HAS_OSM_ROADS:
        return [{"lat": p[0], "lon": p[1]} for p in _interpolate_line_points(origin, dest, n=sample_points)]
    try:
        roads = get_roads_for_city(city_hint, max_roads=400, target_segments=200, use_cache=True)
        candidates = []
        for r in roads:
            coords = r.get("coordinates") or r.get("geometry", {}).get("coordinates") or []
            for pt in coords:
                if isinstance(pt, (list, tuple)) and len(pt) >= 2:
                    try:
                        lon_v = float(pt[0]); lat_v = float(pt[1])
                        candidates.append((lat_v, lon_v))
                    except Exception:
                        continue
        if not candidates:
            return [{"lat": p[0], "lon": p[1]} for p in _interpolate_line_points(origin, dest, n=sample_points)]
    except Exception as e:
        logger.warning("get_roads_for_city failed: %s", e)
        return [{"lat": p[0], "lon": p[1]} for p in _interpolate_line_points(origin, dest, n=sample_points)]

    if len(candidates) > 5000:
        candidates = candidates[:5000]

    def nearest_candidate(pt):
        best = None
        bestd = float("inf")
        for c in candidates:
            d = _haversine_m(pt, c)
            if d < bestd:
                bestd = d
                best = c
        return best, bestd

    samples = _interpolate_line_points(origin, dest, n=sample_points)
    snapped = []
    last = None
    for s in samples:
        near, dist = nearest_candidate(s)
        if near and dist <= max_snap_m:
            lat, lon = float(near[0]), float(near[1])
        else:
            lat, lon = float(s[0]), float(s[1])
        if last is None or _haversine_m((lat,lon), last) > 3.0:
            snapped.append({"lat": lat, "lon": lon})
            last = (lat, lon)
    if len(snapped) == 0 or (_haversine_m((snapped[-1]["lat"], snapped[-1]["lon"]), dest) > 10.0):
        snapped.append({"lat": dest[0], "lon": dest[1]})
    return snapped

#
# Provider racing: start GH (primary) + optionally OSRM/ORS concurrently and pick first valid
#
def _race_providers_for_route(origin: Tuple[float,float], dest: Tuple[float,float], timeout_primary=5.0):
    o_lat, o_lon = origin
    d_lat, d_lon = dest
    q: "Queue[Tuple[str,Any]]" = Queue()

    def run_gh():
        try:
            data = _call_graphhopper_route(o_lat, o_lon, d_lat, d_lon, timeout=timeout_primary, alternatives=False)
            q.put(("gh", data))
        except Exception as e:
            q.put(("gh_err", e))

    def run_osrm():
        try:
            data = _call_osrm_route(o_lat, o_lon, d_lat, d_lon, timeout=timeout_primary, retries=1, alternatives=False)
            q.put(("osrm", data))
        except Exception as e:
            q.put(("osrm_err", e))

    def run_ors():
        try:
            data = _call_ors_route(o_lat, o_lon, d_lat, d_lon, timeout=6.0, alternatives=False)
            q.put(("ors", data))
        except Exception as e:
            q.put(("ors_err", e))

    threads = []
    t_gh = threading.Thread(target=run_gh, daemon=True); threads.append(t_gh); t_gh.start()
    # start OSRM as backup immediately
    t_osrm = threading.Thread(target=run_osrm, daemon=True); threads.append(t_osrm); t_osrm.start()
    if ORS_API_KEY:
        t_ors = threading.Thread(target=run_ors, daemon=True); threads.append(t_ors); t_ors.start()

    start = time.time()
    global_timeout = 8.0
    gh_err = osrm_err = ors_err = None
    while time.time() - start < global_timeout:
        try:
            who, payload = q.get(timeout=global_timeout - (time.time() - start))
        except Empty:
            break
        if who == "gh":
            # validate GH payload
            try:
                if not isinstance(payload, dict) or not payload.get("paths"):
                    gh_err = RuntimeError("GraphHopper returned invalid payload")
                else:
                    return ("gh", payload)
            except Exception as e:
                gh_err = e
        elif who == "osrm":
            try:
                if not isinstance(payload, dict) or payload.get("code") != "Ok" or not payload.get("routes"):
                    osrm_err = RuntimeError("OSRM returned invalid payload")
                else:
                    return ("osrm", payload)
            except Exception as e:
                osrm_err = e
        elif who == "ors":
            return ("ors", payload)
        elif who == "gh_err":
            gh_err = payload
        elif who == "osrm_err":
            osrm_err = payload
        elif who == "ors_err":
            ors_err = payload

    # drain queue prefer GH then OSRM then ORS
    try:
        while not q.empty():
            who, payload = q.get_nowait()
            if who == "gh" and isinstance(payload, dict) and payload.get("paths"):
                return ("gh", payload)
            if who == "osrm" and isinstance(payload, dict) and payload.get("routes"):
                return ("osrm", payload)
            if who == "ors" and isinstance(payload, dict):
                return ("ors", payload)
    except Exception:
        pass

    raise RuntimeError(f"No provider returned valid route in time (gh_err={gh_err} osrm_err={osrm_err} ors_err={ors_err})")

#
# compute_best_route: use race; normalize GH/OSRM/ORS outputs
#
def compute_best_route(
    origin: Tuple[float, float],
    dest: Tuple[float, float],
    vehicle_id: str | None = None,
    avoid_tolls: bool = False,
    prefer_clear: bool = True,
) -> Dict[str, Any]:
    o_lat, o_lon = origin
    d_lat, d_lon = dest
    if not (_is_valid_coord_pair(o_lat, o_lon) and _is_valid_coord_pair(d_lat, d_lon)):
        raise ValueError(f"Invalid origin/destination coordinates origin=({origin}) dest=({dest})")
    try:
        provider_name, payload = _race_providers_for_route(origin, dest, timeout_primary=5.0)
        if provider_name == "gh":
            # GraphHopper payload: paths[0].points.coordinates = [[lon,lat], ...] when points_encoded=false
            path = payload.get("paths", [])[0]
            coords = path.get("points", {}).get("coordinates", []) or []
            if not coords or len(coords) < 2:
                raise RuntimeError("GraphHopper returned empty geometry")
            path_points = _coords_lonlat_to_path(coords)
            distance_m = float(path.get("distance", 0.0) or 0.0)
            # GraphHopper provides time in ms
            duration_s = float((path.get("time", 0) or 0) / 1000.0)
        elif provider_name == "osrm":
            route0 = payload["routes"][0]
            coords = route0.get("geometry", {}).get("coordinates", []) or []
            if not coords or len(coords) < 2:
                raise RuntimeError("OSRM returned empty geometry")
            path_points = _coords_lonlat_to_path(coords)
            distance_m = float(route0.get("distance", 0.0) or 0.0)
            duration_s = float(route0.get("duration", 0.0) or 0.0)
        else:  # ors
            feat = payload.get("features", [None])[0]
            if not feat:
                raise RuntimeError("ORS returned no features")
            coords = feat.get("geometry", {}).get("coordinates", []) or []
            if not coords or len(coords) < 2:
                raise RuntimeError("ORS returned empty geometry")
            path_points = _coords_lonlat_to_path(coords)
            props = feat.get("properties", {}) or {}
            summary = props.get("summary", {}) or {}
            distance_m = float(summary.get("distance", 0.0) or 0.0)
            duration_s = float(summary.get("duration", 0.0) or 0.0)

        intersections = []
        n = len(path_points)
        now = time.time()
        if n >= 2:
            for i, frac in enumerate([0.25, 0.5, 0.75], start=1):
                idx = min(n-1, int(frac*(n-1)))
                pt = path_points[idx]
                eta_s = duration_s * frac
                intersections.append({
                    "id": f"INT_{i}",
                    "lat": pt["lat"],
                    "lon": pt["lon"],
                    "eta_s": eta_s,
                    "eta_epoch": now + eta_s
                })
        else:
            intersections.append({"id":"INT_1","lat":o_lat,"lon":o_lon,"eta_s":0.0,"eta_epoch":now})

        return {
            "distance_m": float(distance_m),
            "duration_s": float(duration_s),
            "polyline": "",
            "intersections": intersections,
            "path": path_points,
        }
    except Exception as e:
        logger.warning("Primary providers failed or timed out: %s -- falling back to snapping/straight", e)

    # fallback: snapping
    try:
        snapped = _snap_samples_to_nearest_road_points(origin, dest, city_hint="Mumbai", sample_points=36, max_snap_m=400.0)
        dist = 0.0
        prev = None
        for p in snapped:
            if prev is not None:
                dist += _haversine_m(prev, (p["lat"], p["lon"]))
            prev = (p["lat"], p["lon"])
        avg_speed_mps = 11.11
        duration = max(1.0, dist / avg_speed_mps)
        now = time.time()
        n = len(snapped)
        intersections = []
        for i, frac in enumerate([0.25, 0.5, 0.75], start=1):
            idx = min(n-1, int(frac*(n-1)))
            p = snapped[idx]
            eta_s = duration * frac
            intersections.append({
                "id": f"INT_SF_{i}",
                "lat": p["lat"],
                "lon": p["lon"],
                "eta_s": eta_s,
                "eta_epoch": now + eta_s,
            })
        path_points = [{"lat": float(p["lat"]), "lon": float(p["lon"])} for p in snapped]
        return {
            "distance_m": float(dist),
            "duration_s": float(duration),
            "polyline": "",
            "intersections": intersections,
            "path": path_points,
        }
    except Exception as e:
        logger.exception("Fallback snapped path construction failed: %s", e)
        straight = _interpolate_line_points(origin, dest, n=20)
        dist = sum(_haversine_m(straight[i], straight[i+1]) for i in range(len(straight)-1))
        avg_speed_mps = 11.11
        duration = max(1.0, dist / avg_speed_mps)
        now = time.time()
        n = len(straight)
        intersections = []
        for i, frac in enumerate([0.25, 0.5, 0.75], start=1):
            idx = min(n-1, int(frac*(n-1)))
            p = straight[idx]
            eta_s = duration * frac
            intersections.append({
                "id": f"INT_SL_{i}",
                "lat": p[0],
                "lon": p[1],
                "eta_s": eta_s,
                "eta_epoch": now + eta_s,
            })
        path_points = [{"lat": p[0], "lon": p[1]} for p in straight]
        return {
            "distance_m": float(dist),
            "duration_s": float(duration),
            "polyline": "",
            "intersections": intersections,
            "path": path_points,
        }

#
# compute_routes_with_alternatives: try GH alternatives (GraphHopper alt support limited),
# then OSRM/ORS alternatives, then nudged variants + dedupe
#
def compute_routes_with_alternatives(origin, dest, vehicle_id: str, max_alternatives: int = 3) -> List[Dict[str, Any]]:
    o_lat, o_lon = origin
    d_lat, d_lon = dest
    routes: List[Dict[str, Any]] = []

    # 1) Try GraphHopper (primary) - GraphHopper may return only one path; still attempt
    try:
        gh_payload = _call_graphhopper_route(o_lat, o_lon, d_lat, d_lon, timeout=6, alternatives=False)
        if gh_payload and gh_payload.get("paths"):
            for p in gh_payload.get("paths", []):
                coords = p.get("points", {}).get("coordinates", []) or []
                if not coords or len(coords) < 2:
                    continue
                path_points = _coords_lonlat_to_path(coords)
                distance_m = float(p.get("distance", 0.0) or 0.0)
                duration_s = float((p.get("time", 0) or 0) / 1000.0)
                intersections = []
                n = len(path_points)
                now = time.time()
                if n >= 2:
                    for j, frac in enumerate([0.25, 0.5, 0.75], start=1):
                        idxp = min(n-1, int(frac*(n-1)))
                        pt = path_points[idxp]
                        eta_s = duration_s * frac
                        intersections.append({
                            "id": f"INT_GH_{j}",
                            "lat": pt["lat"],
                            "lon": pt["lon"],
                            "eta_s": eta_s,
                            "eta_epoch": now + eta_s,
                        })
                else:
                    intersections.append({"id":"INT_GH_1","lat":o_lat,"lon":o_lon,"eta_s":0.0,"eta_epoch":time.time()})
                routes.append({
                    "distance_m": distance_m,
                    "duration_s": duration_s,
                    "polyline": "",
                    "intersections": intersections,
                    "path": path_points,
                })
    except Exception as e:
        logger.info("GraphHopper primary failed: %s", e)

    # 2) Try OSRM alternatives
    try:
        osrm_data = _call_osrm_route(o_lat, o_lon, d_lat, d_lon, timeout=6, retries=1, alternatives=True)
        if osrm_data.get("code") == "Ok":
            for idx, route0 in enumerate(osrm_data.get("routes", [])):
                coords_lonlat = route0.get("geometry", {}).get("coordinates", []) or []
                if not coords_lonlat or len(coords_lonlat) < 2:
                    continue
                path_points = _coords_lonlat_to_path(coords_lonlat)
                distance_m = float(route0.get("distance", 0.0) or 0.0)
                duration_s = float(route0.get("duration", 0.0) or 0.0)
                intersections = []
                n = len(path_points)
                now = time.time()
                if n >= 2:
                    for j, frac in enumerate([0.25, 0.5, 0.75], start=1):
                        idxp = min(n-1, int(frac*(n-1)))
                        pt = path_points[idxp]
                        eta_s = duration_s * frac
                        intersections.append({
                            "id": f"INT_OSRM_{idx+1}_{j}",
                            "lat": pt["lat"],
                            "lon": pt["lon"],
                            "eta_s": eta_s,
                            "eta_epoch": now + eta_s,
                        })
                else:
                    intersections.append({"id": f"INT_OSRM_{idx+1}_1", "lat": o_lat, "lon": o_lon, "eta_s":0.0, "eta_epoch":time.time()})
                routes.append({
                    "distance_m": distance_m,
                    "duration_s": duration_s,
                    "polyline": "",
                    "intersections": intersections,
                    "path": path_points,
                })
    except Exception as e:
        logger.info("OSRM alternatives failed or not reachable: %s", e)

    # 3) ORS alternatives (if configured)
    if ORS_API_KEY and len(routes) < max_alternatives:
        try:
            ors_data = _call_ors_route(o_lat, o_lon, d_lat, d_lon, timeout=6, alternatives=True)
            feats = ors_data.get("features", []) or []
            for idx, feat in enumerate(feats):
                coords = feat.get("geometry", {}).get("coordinates", []) or []
                if not coords or len(coords) < 2:
                    continue
                path_points = _coords_lonlat_to_path(coords)
                props = feat.get("properties", {}) or {}
                summary = props.get("summary", {}) or {}
                distance_m = float(summary.get("distance", 0.0) or 0.0)
                duration_s = float(summary.get("duration", 0.0) or 0.0)
                intersections = []
                n = len(path_points)
                now = time.time()
                if n >= 2:
                    for j, frac in enumerate([0.25, 0.5, 0.75], start=1):
                        idxp = min(n-1, int(frac*(n-1)))
                        pt = path_points[idxp]
                        eta_s = duration_s * frac
                        intersections.append({
                            "id": f"INT_ORS_{idx+1}_{j}",
                            "lat": pt["lat"],
                            "lon": pt["lon"],
                            "eta_s": eta_s,
                            "eta_epoch": now + eta_s,
                        })
                else:
                    intersections.append({"id": f"INT_ORS_{idx+1}_1", "lat": o_lat, "lon": o_lon, "eta_s":0.0, "eta_epoch":time.time()})
                routes.append({
                    "distance_m": distance_m,
                    "duration_s": duration_s,
                    "polyline": "",
                    "intersections": intersections,
                    "path": path_points,
                })
                if len(routes) >= max_alternatives:
                    break
        except Exception as e:
            logger.info("ORS alternatives attempt failed: %s", e)

    # 4) Ensure primary present (compute_best_route fallback)
    if not routes:
        try:
            primary = compute_best_route(origin=origin, dest=dest, vehicle_id=vehicle_id)
            routes.append(primary)
        except Exception as e:
            logger.exception("compute_best_route failed: %s", e)

    # 5) Nudged alternates if still fewer than needed
    if len(routes) < max_alternatives:
        offset_mags = [0.0006, 0.0009, 0.0018, 0.0025, -0.0009, -0.0018]
        offsets = []
        for m in offset_mags:
            offsets.extend([(m, 0.0), (0.0, m), (m,m), (m, -m)])
        origin_jitters = [(0.0, 0.0), (0.0006, 0.0), (-0.0006, 0.0), (0.0, 0.0006), (0.0, -0.0006)]
        attempts = 0
        max_attempts = 12
        for o_jit in origin_jitters:
            if len(routes) >= max_alternatives:
                break
            for dx, dy in offsets:
                if len(routes) >= max_alternatives or attempts >= max_attempts:
                    break
                attempts += 1
                try:
                    alt_origin = (origin[0] + o_jit[0], origin[1] + o_jit[1])
                    alt_dest = (dest[0] + dx, dest[1] + dy)
                    if not (_is_valid_coord_pair(alt_dest[0], alt_dest[1]) and _is_valid_coord_pair(alt_origin[0], alt_origin[1])):
                        continue
                    alt = compute_best_route(origin=alt_origin, dest=alt_dest, vehicle_id=vehicle_id)
                    d = float(alt.get("distance_m", 0.0) or 0.0)
                    t = float(alt.get("duration_s", 0.0) or 0.0)
                    is_dup = False
                    for u in routes:
                        ud = float(u.get("distance_m", 0.0) or 0.0)
                        ut = float(u.get("duration_s", 0.0) or 0.0)
                        try:
                            a_end = alt["path"][-1] if alt.get("path") else None
                            u_end = u["path"][-1] if u.get("path") else None
                            end_sep = 0.0
                            if a_end and u_end:
                                end_sep = _haversine_m((a_end["lat"], a_end["lon"]), (u_end["lat"], u_end["lon"]))
                            else:
                                end_sep = abs(d - ud)
                        except Exception:
                            end_sep = abs(d - ud)
                        if abs(d - ud) < 50.0 and abs(t - ut) < 5.0 and end_sep < 40.0:
                            is_dup = True
                            break
                    if not is_dup:
                        routes.append(alt)
                except Exception:
                    continue

    # final dedupe pass
    unique: List[Dict[str, Any]] = []
    for r in routes:
        d = float(r.get("distance_m", 0.0) or 0.0)
        t = float(r.get("duration_s", 0.0) or 0.0)
        found = False
        for u in unique:
            ud = float(u.get("distance_m", 0.0) or 0.0)
            ut = float(u.get("duration_s", 0.0) or 0.0)
            if abs(d - ud) < 50.0 and abs(t - ut) < 5.0:
                found = True
                break
        if not found:
            unique.append(r)
    return unique[:max_alternatives]
