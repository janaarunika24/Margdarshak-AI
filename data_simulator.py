# data_simulator.py (improved simulation using roads)
import pandas as pd
import numpy as np
import os
import logging
from geopy.geocoders import Nominatim
from traffic_provider import get_live_traffic_for_point  # or get_live_traffic_for_road
from osm_roads import get_roads_for_city

logger = logging.getLogger("marg_sim")
logging.basicConfig(level=logging.INFO)

OPENWEATHER = "9505fd1df737e20152fbd78cdb289b6a"  # keep as env var

def geocode(loc):
    if "," in loc:
        try:
            lat, lon = map(float, loc.split(","))
            return lat, lon
        except:
            pass
    try:
        g = Nominatim(user_agent="md_geocoder").geocode(loc, timeout=10)
        if g:
            return g.latitude, g.longitude
    except:
        pass
    return 19.0760, 72.8777

def get_weather_api(city):
    if not OPENWEATHER:
        return {"temp": 25.0, "condition": "Clear"}
    try:
        import requests
        url = "http://api.openweathermap.org/data/2.5/weather"
        r = requests.get(url, params={"q": city, "appid": OPENWEATHER}, timeout=6)
        j = r.json()
        return {"temp": j["main"]["temp"] - 273.15, "condition": j["weather"][0]["main"]}
    except Exception:
        return {"temp": 25.0, "condition": "Clear"}

def _centroid(coords):
    return float(np.mean([c[0] for c in coords])), float(np.mean([c[1] for c in coords]))

def simulate_traffic_data(location="Mumbai", num_segments=5, time_steps=10, road_expand_km=0.3):
    """
    New behavior:
    - Fetch logical roads via get_roads_for_city with target_segments=num_segments.
    - For each road segment produce a continuous time-series. We sample along the road
      to get a 'spatially continuous' profile and then smooth it across neighboring points.
    - road_expand_km increases the "area" influence of each segment for simulated nearby queries.
    Returns DataFrame with columns:
      { segment_id, road_name, time, vehicle_count, speed, weather, temp, lat, lon, length_m }
    """
    lat0, lon0 = geocode(location)
    weather = get_weather_api(location)

    # get roads (merged/split) with target_segments == num_segments
    roads = get_roads_for_city(location, max_roads=max(200, num_segments*3), target_segments=num_segments)

    rows = []
    for r in roads[:num_segments]:
        seg_id = r.get("id")
        name = r.get("name")
        coords = r.get("coordinates") or []
        length_m = r.get("length_m") if r.get("length_m") else max(1.0, sum(
            np.hypot(np.diff([p[0] for p in coords]), np.diff([p[1] for p in coords]))))

        # sample N spatial points along road (min 3, max 8)
        spatial_points = min(max(3, int(len(coords) / 2)), 8)
        # generate evenly spaced indices across coords
        idxs = np.linspace(0, len(coords)-1, spatial_points).astype(int)
        sampled = [coords[i] for i in idxs]

        # get baseline traffic per sampled point using traffic_provider
        baseline_speeds = []
        baseline_counts = []
        for (plat, plon) in sampled:
            try:
                info = get_live_traffic_for_point(plat, plon)
                base_speed = float(info.get("speed", np.random.uniform(20, 50)))
                # normalize jamFactor -> count approximation
                jam = float(info.get("jamFactor", 0) or 0)
                base_count = max(1, int(20 + jam*15 + np.random.randint(-5, 5)))
            except Exception:
                base_speed = float(np.random.uniform(15, 55))
                base_count = int(np.random.randint(5, 120))
            baseline_speeds.append(base_speed)
            baseline_counts.append(base_count)

        # smooth spatially with a small gaussian kernel to make values continuous
        kernel = np.exp(-np.square(np.arange(len(baseline_speeds)) - (len(baseline_speeds)-1)/2) / (2*(1.5**2)))
        kernel = kernel / (kernel.sum() + 1e-9)
        smoothed_speed = np.convolve(baseline_speeds, kernel, mode='same')[:len(baseline_speeds)]
        smoothed_count = np.maximum(1, np.round(np.convolve(baseline_counts, kernel, mode='same'))).astype(int)[:len(baseline_counts)]

        # for each time step produce slightly varying values with temporal autocorrelation
        for t in range(time_steps):
            # temporal trend component (rush hour style)
            trend = 1.0
            # small sinusoidal variation
            trend *= (1 + 0.15 * np.sin(2 * np.pi * (t / max(1, time_steps)) + np.random.uniform(0, 1)))
            for i, (pt, speed0, cnt0) in enumerate(zip(sampled, smoothed_speed, smoothed_count)):
                # add small random walk around baseline
                speed = max(1.0, float(speed0 * (1 + np.random.normal(0, 0.08) * trend)))
                count = int(max(0, cnt0 * (1 + np.random.normal(0, 0.12) * trend)))
                rows.append({
                    "segment": seg_id,
                    "road_name": name,
                    "time": t,
                    "vehicle_count": int(count),
                    "speed": float(speed),
                    "weather": weather["condition"],
                    "temp": weather["temp"],
                    "lat": float(pt[0]),
                    "lon": float(pt[1]),
                    "length_m": float(length_m)
                })

    df = pd.DataFrame(rows)
    # optionally aggregate per-segment (centroid) for endpoints that want a single point per segment
    # compute center for map centering
    if len(roads) > 0:
        center_lat = float(np.mean([_centroid(r["coordinates"])[0] for r in roads[:num_segments]]))
        center_lon = float(np.mean([_centroid(r["coordinates"])[1] for r in roads[:num_segments]]))
    else:
        center_lat, center_lon = lat0, lon0

    return df, center_lat, center_lon
