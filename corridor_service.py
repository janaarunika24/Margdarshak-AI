# corridor_service.py  (HARDENED DROP-IN)
from typing import Dict, Any, List, Tuple
from uuid import uuid4
from datetime import datetime
import time
import logging
import math

from routing_service import compute_routes_with_alternatives
from traffic_provider import get_live_traffic_for_road  # keep your traffic provider interface

logger = logging.getLogger("corridor_service")

_EMERGENCY_REQUESTS: Dict[str, Dict[str, Any]] = {}

def _is_valid_coord_pair(lat, lon) -> bool:
    try:
        a = float(lat)
        b = float(lon)
        if a == 0.0 and b == 0.0:
            return False
        if not (-90.0 <= a <= 90.0 and -180.0 <= b <= 180.0):
            return False
        return True
    except Exception:
        return False

def _haversine_m(a: Tuple[float, float], b: Tuple[float, float]) -> float:
    R = 6371000.0
    lat1, lon1 = math.radians(a[0]), math.radians(a[1])
    lat2, lon2 = math.radians(b[0]), math.radians(b[1])
    dlat = lat2 - lat1
    dlon = lon2 - lon1
    s = math.sin(dlat/2)**2 + math.cos(lat1)*math.cos(lat2)*math.sin(dlon/2)**2
    return 2 * R * math.asin(min(1.0, math.sqrt(s)))

def _interpolate_line(a: Tuple[float,float], b: Tuple[float,float], n_points: int = 12):
    if n_points < 2:
        return [list(a), list(b)]
    pts = []
    for i in range(n_points):
        t = i / (n_points - 1)
        lat = a[0] + (b[0] - a[0]) * t
        lon = a[1] + (b[1] - a[1]) * t
        pts.append({"lat": lat, "lon": lon})
    return pts

def _make_synthetic_route(origin: Tuple[float,float], dest: Tuple[float,float]) -> Dict[str, Any]:
    dist = _haversine_m(origin, dest)
    avg_speed_mps = 11.11
    duration = max(1.0, dist / avg_speed_mps)
    path_pts = _interpolate_line(origin, dest, n_points=14)
    now = time.time()
    n = len(path_pts)
    intersections = []
    for i, frac in enumerate([0.25, 0.5, 0.75], start=1):
        idx = min(n-1, int(frac * (n-1)))
        p = path_pts[idx]
        eta_s = duration * frac
        intersections.append({
            "id": f"INT_SF_{i}",
            "lat": p["lat"],
            "lon": p["lon"],
            "eta_s": eta_s,
            "eta_epoch": now + eta_s,
        })
    return {
        "distance_m": float(dist),
        "duration_s": float(duration),
        "polyline": "",
        "intersections": intersections,
        "path": path_pts,
    }

def create_emergency_request(req) -> Dict[str, Any]:
    try:
        o_lat = float(req.origin_lat)
        o_lon = float(req.origin_lon)
        d_lat = float(req.dest_lat)
        d_lon = float(req.dest_lon)
    except Exception:
        logger.warning("create_emergency_request: invalid coordinate types")
        raise ValueError("Invalid origin/destination coordinates")

    if not (_is_valid_coord_pair(o_lat, o_lon) and _is_valid_coord_pair(d_lat, d_lon)):
        logger.warning("create_emergency_request: rejected coordinates origin=(%s,%s) dest=(%s,%s)", o_lat, o_lon, d_lat, d_lon)
        raise ValueError("Invalid origin/destination coordinates (missing or placeholder 0,0)")

    origin = (o_lat, o_lon)
    dest = (d_lat, d_lon)
    logger.info("create_emergency_request: origin=%s dest=%s vehicle=%s", origin, dest, getattr(req, "vehicle_id", None))

    try:
        candidate_routes = compute_routes_with_alternatives(
            origin=origin,
            dest=dest,
            vehicle_id=getattr(req, "vehicle_id", None),
            max_alternatives=3,
        )
        if not candidate_routes:
            logger.warning("compute_routes_with_alternatives returned empty; using synthetic fallback")
            candidate_routes = [_make_synthetic_route(origin, dest)]
    except Exception as e:
        logger.exception("compute_routes_with_alternatives failed; using synthetic fallback: %s", e)
        candidate_routes = [_make_synthetic_route(origin, dest)]

    enriched_routes: List[Dict[str, Any]] = []
    for r in candidate_routes:
        try:
            score = _score_route_traffic(r)
        except Exception:
            score = {"avg_jam_factor": 0.0, "severity_pct": 10.0}
        tmp = dict(r)
        tmp["traffic"] = score
        sev = float(score.get("severity_pct", 0.0) or 0.0)
        duration_multiplier = 1.0 + (sev / 100.0) * 0.5
        try:
            base_dur = float(tmp.get("duration_s", 0.0) or 0.0)
            adj_dur = base_dur * duration_multiplier
            tmp["duration_s_adjusted"] = adj_dur
            tmp["duration_s"] = adj_dur
        except Exception:
            pass
        enriched_routes.append(tmp)

    def route_cost(r: Dict[str, Any]) -> float:
        dur = float(r.get("duration_s", 0.0) or 0.0)
        sev = float(r.get("traffic", {}).get("severity_pct", 0.0) or 0.0)
        return dur * (1.0 + sev / 200.0)

    enriched_routes.sort(key=route_cost)
    primary_route = enriched_routes[0]

    primary_severity = float(primary_route.get("traffic", {}).get("severity_pct", 0.0) or 0.0)
    if primary_severity > 50:
        visible_alts = enriched_routes[1:3]
    else:
        visible_alts = enriched_routes[1:2]

    request_id = str(uuid4())
    corridor_plan = _plan_corridor(primary_route)
    corridor_plan["alternatives"] = [
        {
            "id": f"alt_{idx + 1}",
            "route": r,
            "traffic": r.get("traffic", {}),
        }
        for idx, r in enumerate(visible_alts)
    ]

    _EMERGENCY_REQUESTS[request_id] = {
        "request": getattr(req, "model_dump", lambda: {} )(),
        "route": primary_route,
        "routes_all": enriched_routes,
        "created_at": datetime.utcnow().timestamp(),
        "status": "active",
        "last_position": {"lat": o_lat, "lon": o_lon},
        "corridor_plan": corridor_plan,
    }

    logger.info("create_emergency_request: created request_id=%s with primary distance=%.1fm dur=%.1fs severity=%.1f",
                request_id, float(primary_route.get("distance_m", 0.0) or 0.0), float(primary_route.get("duration_s", 0.0) or 0.0), primary_severity)

    return {
        "request_id": request_id,
        "route": primary_route,
        "corridor_plan": corridor_plan,
    }

def _score_route_traffic(route: Dict[str, Any]) -> Dict[str, Any]:
    path: List[Dict[str, float]] = route.get("path", []) or route.get("geometry") or []
    if not path:
        return {"avg_jam_factor": 0.0, "severity_pct": 0.0}

    sample_count = min(8, len(path))
    step = max(1, len(path) // sample_count)

    severity_vals: List[float] = []
    jam_vals: List[float] = []

    for i in range(0, len(path), step):
        pt = path[i]
        if isinstance(pt, dict):
            lat = pt.get("lat") or pt.get("latitude") or pt.get("y")
            lon = pt.get("lon") or pt.get("lng") or pt.get("longitude") or pt.get("x")
        elif isinstance(pt, (list, tuple)) and len(pt) >= 2:
            lat, lon = pt[0], pt[1]
        else:
            continue

        try:
            lat = float(lat); lon = float(lon)
        except Exception:
            continue

        try:
            info = get_live_traffic_for_road([[lat, lon]])
        except Exception:
            info = None

        if info:
            jf = info.get("jamFactor")
            sev = info.get("severity")
            if jf is not None:
                try:
                    jam_vals.append(float(jf))
                except Exception:
                    pass
            if sev is not None:
                try:
                    severity_vals.append(float(sev))
                except Exception:
                    pass

    if severity_vals:
        avg_sev = sum(severity_vals) / len(severity_vals)
        avg_jf = (sum(jam_vals) / len(jam_vals)) if jam_vals else (avg_sev / 10.0)
        return {"avg_jam_factor": avg_jf, "severity_pct": max(0.0, min(100.0, avg_sev))}

    if jam_vals:
        avg_jf = sum(jam_vals) / len(jam_vals)
        return {"avg_jam_factor": avg_jf, "severity_pct": max(0.0, min(100.0, avg_jf * 10.0))}

    logger.debug("No live traffic returned for route samples; using fallback severity")
    return {"avg_jam_factor": 0.0, "severity_pct": 10.0}

def update_vehicle_position(update) -> Dict[str, Any]:
    if update.request_id not in _EMERGENCY_REQUESTS:
        raise ValueError("Invalid request_id")

    st = _EMERGENCY_REQUESTS[update.request_id]
    st["last_position"] = {
        "lat": update.lat,
        "lon": update.lon,
        "speed_mps": update.speed_mps,
        "bearing_deg": update.bearing_deg,
        "ts": update.ts,
    }

    return {
        "request_id": update.request_id,
        "status": st["status"],
        "corridor_plan": st["corridor_plan"],
    }

def get_emergency_status(request_id: str) -> Dict[str, Any] | None:
    st = _EMERGENCY_REQUESTS.get(request_id)
    if not st:
        return None
    corridor_plan = st["corridor_plan"]
    return {
        "request_id": request_id,
        "status": st["status"],
        "route": st["route"],
        "intersections": corridor_plan.get("intersections", []),
        "alternatives": corridor_plan.get("alternatives", []),
    }

def _plan_corridor(route: Dict[str, Any]) -> Dict[str, Any]:
    intersections = route.get("intersections", []) or []
    severity = float(route.get("traffic", {}).get("severity_pct", 0.0) or 0.0)
    delay_multiplier = 1.0 + (severity / 100.0) * 0.5

    adjusted: List[Dict[str, Any]] = []
    now = time.time()
    for intr in intersections:
        eta_s = float(intr.get("eta_s", 0.0) or 0.0)
        adj_eta = eta_s * delay_multiplier
        new_intr = dict(intr)
        new_intr["eta_s"] = adj_eta
        new_intr["eta_epoch"] = now + adj_eta
        adjusted.append(new_intr)

    return {"intersections": adjusted}
