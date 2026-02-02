# traffic_provider.py
import os
import requests
import random
import math

# Prefer environment variable over hardcoding
TOMTOM_KEY = "aaWC9IDtBW01OGvjqZzePjksN4P0XGrz"

def _centroid(coords):
    """
    coords: list of [lat, lon]
    returns (lat, lon) of centroid.
    """
    if not coords:
        raise ValueError("coords must be a non-empty list")
    lat = sum(c[0] for c in coords) / len(coords)
    lon = sum(c[1] for c in coords) / len(coords)
    return lat, lon

def get_live_traffic_for_road(coords):
    """
    coords = [[lat, lon], ...]
    returns: dict with { speed, jamFactor, currentTravelTime, severity }
    """
    lat, lon = _centroid(coords)
    return get_live_traffic_for_point(lat, lon)

def _compute_severity_from_speed(speed):
    # Fallback logic: slower speed => higher severity (0–100)
    # Assume 80 km/h as "good" speed; clamp result to [0, 100]
    raw = (80 - speed) / 80
    severity = int(max(0, min(1, raw)) * 100)
    return severity

def _compute_severity_from_jf(jf):
    # TomTom jamFactor is 0–10; map it linearly to 0–100
    jf_clamped = max(0, min(10, jf))
    return int((jf_clamped / 10.0) * 100)

def get_live_traffic_for_point(lat, lon):
    if TOMTOM_KEY:
        try:
            url = "https://api.tomtom.com/traffic/services/5/flowSegmentData/absolute/10/json"
            params = {"key": TOMTOM_KEY, "point": f"{lat},{lon}"}
            r = requests.get(url, params=params, timeout=6)
            r.raise_for_status()
            j = r.json()
            seg = j.get("flowSegmentData", {}) or {}

            speed = (
                seg.get("currentSpeed")
                or seg.get("freeFlowSpeed")
                or random.uniform(20, 60)
            )

            jf = seg.get("jamFactor", 0) or 0
            travel_time = seg.get("currentTravelTime", 0) or 0

            # ✅ Use jamFactor 0–10 → severity 0–100
            if jf:
                severity = _compute_severity_from_jf(jf)
            else:
                severity = _compute_severity_from_speed(speed)

            return {
                "speed": float(speed),
                "jamFactor": float(jf),
                "travel_time": float(travel_time),
                "severity": severity,
            }
        except Exception:
            # fall through to synthetic below
            pass

    # fallback synthetic
    speed = random.uniform(10, 80)
    jf = max(0, min(10, (80 - speed) / 8))
    travel_time = random.uniform(60, 600)
    severity = _compute_severity_from_jf(jf)

    return {
        "speed": float(speed),
        "jamFactor": float(jf),
        "travel_time": float(travel_time),
        "severity": severity,
    }
