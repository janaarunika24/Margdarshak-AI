# geocode_service.py
import requests

USER_AGENT = "margdarshak-geocoder/1.0"  # be nice to Nominatim

def geocode(address: str):
    """
    Use Nominatim (OpenStreetMap) to convert address -> (lat, lon).
    This is free & good enough for demo.
    """
    url = "https://nominatim.openstreetmap.org/search"
    params = {
        "q": address,
        "format": "json",
        "limit": 1,
    }
    headers = {"User-Agent": USER_AGENT}
    r = requests.get(url, params=params, headers=headers, timeout=8)
    r.raise_for_status()
    data = r.json()
    if not data:
        return None
    return {
        "lat": float(data[0]["lat"]),
        "lon": float(data[0]["lon"]),
        "display_name": data[0].get("display_name", address),
    }
