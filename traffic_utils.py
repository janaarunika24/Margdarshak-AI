# traffic_utils.py

import os
import requests

TOMTOM = "aaWC9IDtBW01OGvjqZzePjksN4P0XGrz"

def get_tomtom(lat, lon):
    if not TOMTOM:
        return None
    try:
        url = (
            "https://api.tomtom.com/traffic/services/4/"
            "flowSegmentData/relative0/10/json"
        )
        r = requests.get(
            url,
            params={"key": TOMTOM, "point": f"{lat},{lon}"},
            timeout=6,
        )
        j = r.json().get("flowSegmentData", {})
        return {"speed": j.get("currentSpeed", 0), "jam": j.get("jamFactor", 0)}
    except:
        return None
