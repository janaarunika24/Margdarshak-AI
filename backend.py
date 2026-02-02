import os
import logging
import datetime
from typing import Optional, List, Dict, Any
from geocode_service import geocode
from db import store_traffic_point, get_history,normalize_segment
from fastapi import FastAPI, HTTPException, Header, Depends, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from predictors.saturation_predictor import predict_with_saturation
from fastapi.responses import FileResponse
from pydantic import BaseModel
from db import get_user
from ml_model import train_and_predict
from data_simulator import simulate_traffic_data, get_weather_api
from osm_roads import get_roads_for_city
from traffic_provider import get_live_traffic_for_road
from routing_service import compute_best_route
from corridor_service import (
    create_emergency_request,
    update_vehicle_position,
    get_emergency_status,
)
import jwt


class RouteRequest(BaseModel):
    origin_lat: float
    origin_lon: float
    dest_lat: float
    dest_lon: float
    vehicle_id: Optional[str] = None
    avoid_tolls: bool = False
    prefer_clear_route: bool = True  # use traffic data to avoid congestion


class RouteResponse(BaseModel):
    distance_m: float
    duration_s: float
    polyline: str
    intersections: List[Dict[str, Any]]  # each: {id, lat, lon, eta_s}


class EmergencyRequest(BaseModel):
    vehicle_id: str
    origin_lat: float
    origin_lon: float
    dest_lat: float
    dest_lon: float
    priority: str = "high"  # or "medium"


class GPSUpdate(BaseModel):
    vehicle_id: str
    request_id: str
    lat: float
    lon: float
    speed_mps: Optional[float] = None
    bearing_deg: Optional[float] = None
    ts: Optional[float] = None  # epoch seconds


class EmergencyStatusResponse(BaseModel):
    request_id: str
    status: str
    route: Optional[Dict[str, Any]] = None
    intersections: Optional[List[Dict[str, Any]]] = None
    alternatives: Optional[List[Dict[str, Any]]] = None




logger = logging.getLogger("marg_backend")
LOG_LEVEL = os.environ.get("MARG_LOG_LEVEL", "INFO").upper()
try:
    lvl = getattr(logging, LOG_LEVEL)
except Exception:
    lvl = logging.INFO
logging.basicConfig(level=lvl)

API_KEY = os.environ.get("MARG_API_KEY", "1a6x1hi1wlUUYkBcUEDuQ5xjdRrqKda6mJXF8Ayf2oc")
JWT_SECRET = os.environ.get("MARG_JWT_SECRET", "-bzxdkR0nS_3X9kpPAJDHxsqJftXgJ6RsY7OfzYDdkoVkWhkp0FXKVktOHGj13Gy")
JWT_ALGO = "HS256"
FRONTEND_DIR = os.environ.get("FRONTEND_BUILD_DIR", "frontend/dist")

app = FastAPI(title="MargDarshak AI Backend")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
    allow_credentials=True
)

if os.path.isdir(FRONTEND_DIR):
    app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")


def require_api_key(x_api_key: Optional[str] = Header(None)):
    if x_api_key != API_KEY:
        raise HTTPException(401, "Invalid or missing x-api-key")
    return True

def create_jwt(user: str):
    now = datetime.datetime.utcnow()
    payload = {"sub": user, "iat": now, "exp": now + datetime.timedelta(hours=4)}
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGO)


class LoginRequest(BaseModel):
    username: str
    password: str

class LocationRequest(BaseModel):
    location: str = "Mumbai"
    num_segments: int = 5
    time_steps: int = 10

class PredictionRequest(BaseModel):
    segment_data: List[float]

class PredictTodayRequest(BaseModel):
    segment_id: str
    interval_min: int = 30
    time_steps: int = 48   # THIS now matters



class BatchPredictionRequest(BaseModel):
    segments: Dict[str, List[float]]


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/api/login")
def login(req: LoginRequest):
    user = get_user(req.username)

    if not user:
        raise HTTPException(401, "Invalid credentials")

    # PLAIN TEXT CHECK (NO HASH)
    if req.password != user["password"]:
        raise HTTPException(401, "Invalid credentials")

    token = create_jwt(req.username)
    return {
        "access_token": token,
        "token_type": "bearer",
        "role": user.get("role", "user")
    }


@app.post("/api/data", dependencies=[Depends(require_api_key)])
def api_data(req: LocationRequest):
    try:
        df, lat, lon = simulate_traffic_data(
            location=req.location, num_segments=req.num_segments, time_steps=req.time_steps
        )
        return {"data": df.to_dict(orient="records"), "center_lat": lat, "center_lon": lon}
    except Exception as e:
        logger.exception("simulate failed")
        raise HTTPException(500, str(e))


@app.get("/api/geocode", dependencies=[Depends(require_api_key)])
def api_geocode(address: str):
    """
    Convert a free-text address into lat/lon using Nominatim.
    Example: /api/geocode?address=Andheri,Mumbai
    """
    try:
        result = geocode(address)
        if not result:
            raise HTTPException(404, "Address not found")
        return result
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("geocode failed")
        raise HTTPException(500, str(e))


@app.post("/api/route", dependencies=[Depends(require_api_key)], response_model=RouteResponse)
def api_route(req: RouteRequest):
    """
    Compute shortest & clearest route using traffic-aware routing.
    Uses external traffic API / routing_service under the hood.
    """
    try:
        route = compute_best_route(
            origin=(req.origin_lat, req.origin_lon),
            dest=(req.dest_lat, req.dest_lon),
            vehicle_id=req.vehicle_id,
            avoid_tolls=req.avoid_tolls,
            prefer_clear=req.prefer_clear_route,
        )
        return route
    except Exception as e:
        logger.exception("route failed")
        raise HTTPException(500, str(e))


@app.post("/api/emergency/request", dependencies=[Depends(require_api_key)])
def api_emergency_request(req: EmergencyRequest):
    """
    Called when ambulance triggers Green Corridor request.
    Computes initial best route + stores request.
    """
    try:
        result = create_emergency_request(req)
        return result  # e.g. {request_id, route, intersections}
    except Exception as e:
        logger.exception("emergency request failed")
        raise HTTPException(500, str(e))

@app.post("/api/emergency/update_position", dependencies=[Depends(require_api_key)])
def api_emergency_update_position(req: GPSUpdate):
    """
    Called periodically with GPS updates from the ambulance.
    Recomputes ETAs & updates corridor schedule.
    """
    try:
        result = update_vehicle_position(req)
        return result  # e.g. {request_id, updated_etas, active_corridor_segments}
    except Exception as e:
        logger.exception("emergency update failed")
        raise HTTPException(500, str(e))

@app.get("/api/emergency/status/{request_id}", dependencies=[Depends(require_api_key)], response_model=EmergencyStatusResponse)
def api_emergency_status(request_id: str):
    """
    Frontend / control-room polls this to see corridor status.
    """
    try:
        status = get_emergency_status(request_id)
        if status is None:
            raise HTTPException(404, "request_id not found")
        return status
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("emergency status failed")
        raise HTTPException(500, str(e))


def fetch_last_7_days(segment_id: str, interval_min: int = 30):
    """
    TEMPORARY implementation:
    - Generates synthetic historical data for last 7 days
    - interval_min = 30 → 48 points/day → 336 points
    Replace later with DB / cache.
    """
    points_per_day = int(24 * 60 / interval_min)
    total_points = 7 * points_per_day

    import numpy as np

    base = np.random.randint(20, 60)
    noise = np.random.normal(0, 8, total_points)
    trend = np.linspace(-5, 5, total_points)

    series = base + noise + trend
    return series.tolist()


@app.post("/api/predict", dependencies=[Depends(require_api_key)])
def api_predict(req: PredictionRequest):
    try:
        r = train_and_predict(req.segment_data)
        return {"predicted_congestion": float(r)}
    except Exception as e:
        logger.exception("predict fail")
        raise HTTPException(500, str(e))

@app.post("/api/predict_today")
def api_predict_today(req: PredictTodayRequest, city: str = Query(...)):
    segment_id = normalize_segment(city, req.segment_id)

    history = get_history(
        segment_id=segment_id,
        city=city,
        interval_min=req.interval_min,
        limit=336
    )

    if len(history) < 2:
        return {
            "segment": segment_id,
            "city": city,
            "avg_7d": 0.0,
            "predicted_today": 0.0,
            "status": "no_data"
        }

    avg_7d = sum(history) / len(history)
    pred = predict_with_saturation(history, max_capacity=100)

    return {
        "segment": segment_id,
        "city": city,
        "avg_7d": float(avg_7d),
        "predicted_today": float(pred),
        "status": "ok"
    }


@app.post("/api/predict_batch", dependencies=[Depends(require_api_key)])
def api_predict_batch(req: BatchPredictionRequest):
    try:
        out = {}
        for seg, arr in req.segments.items():
            out[seg] = float(train_and_predict(arr))
        return {"predictions": out}
    except Exception as e:
        logger.exception("batch failed")
        raise HTTPException(500, str(e))

@app.get("/api/live_traffic", dependencies=[Depends(require_api_key)])
def api_live_traffic(
    road_id: str,
    city: str,
    lat: Optional[float] = None,
    lon: Optional[float] = None
):
    resp = get_live_traffic_for_road(
        [[lat, lon]] if lat is not None and lon is not None else [[19.0760, 72.8777]]
    )

    d = resp.get("data", resp)
    sev = d.get("severity")
    if sev is None:
        sev = (d.get("jamFactor", 0)) * 100

    segment_id = normalize_segment(city, road_id)

    # 🔥 STORE LIVE DATA (THIS WAS MISSING)
    store_traffic_point(
        segment_id=segment_id,
        value=float(sev),
        interval_min=30,
        city=city
    )

    return {
        "segment_id": segment_id,
        "severity": float(sev),
        "source": "live",
        "ts": datetime.datetime.utcnow().isoformat()
    }

@app.get("/api/weather/{city}", dependencies=[Depends(require_api_key)])
def api_weather(city: str):
    try:
        return get_weather_api(city)
    except Exception as e:
        logger.exception("weather fail")
        raise HTTPException(500, str(e))


# ---------- NEW: roads & live traffic ----------
@app.post("/api/dev/seed_city_history", dependencies=[Depends(require_api_key)])
def seed_city_history(city: str, points: int = 6, interval_min: int = 30):
    roads = get_roads_for_city(city, max_roads=200)

    for road in roads:
        segment_id = normalize_segment(city, road["id"])
        for i in range(points):
            store_traffic_point(
                segment_id,
                35 + (i * 4),
                interval_min,
                city
            )

    return {"city": city, "segments": len(roads), "points": points}


@app.get("/api/roads", dependencies=[Depends(require_api_key)])
def api_roads(city: str = Query("Mumbai"), max_roads: int = Query(200), target_segments: int = Query(None)):
    try:
        roads = get_roads_for_city(city, max_roads=max_roads, target_segments=target_segments)
        return {"roads": roads}
    except Exception as e:
        logger.exception("roads failed")
        raise HTTPException(500, str(e))

@app.get("/")
def frontend_root():
    if os.path.exists(os.path.join(FRONTEND_DIR, "index.html")):
        return FileResponse(os.path.join(FRONTEND_DIR, "index.html"))
    return {"message": "Server Started"}
