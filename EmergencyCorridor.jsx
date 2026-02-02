import { useState, useMemo, useEffect } from "react";
import {
  MapContainer,
  TileLayer,
  Marker,
  Polyline,
  Tooltip,
  useMap,
  GeoJSON,
} from "react-leaflet";

/**
 * EmergencyCorridor (updated)
 * - ETA uses 40 km/h average speed
 * - alternatives robustly parsed and logged to console
 * - segments are grouped to reduce density (SEGMENT_GROUP_SIZE)
 * - optional custom GeoJSON overlay (for user-supplied boundaries)
 *
 * NOTE on geopolitics: Base tiles (Carto/OSM) determine country depiction.
 * If you want a custom boundary overlay (e.g., to show a specific line),
 * provide a GeoJSON and set `customBoundaryGeoJson` below.
 */

export default function EmergencyCorridor() {
  const API = "https://margdarshak-ai-production.up.railway.app";
  const API_KEY = "1a6x1hi1wlUUYkBcUEDuQ5xjdRrqKda6mJXF8Ayf2oc";

  // ---------- CONFIG ----------
  const SEGMENT_GROUP_SIZE = 5; // group every N small segments into one (increase to reduce polylines)
  const AVG_SPEED_KMPH = 30; // per your request
  // Optional: supply custom GeoJSON to overlay a boundary. Leave null/empty if you don't want it.
  // Be mindful of political sensitivity. Provide your own GeoJSON coordinates if desired.
  const customBoundaryGeoJson = null; // e.g. { "type":"Feature", "geometry":{ "type":"Polygon", "coordinates":[ [ [lon,lat], ... ] ] } }

  const THEME = {
    bg: "#07070a",
    cardBg: "#0b1116",
    text: "#E6EEF3",
    muted: "#9CA3AF",
    border: "rgba(255,255,255,0.06)",
    inputBg: "#0f1720",
    inputBorder: "rgba(255,255,255,0.06)",
    shadow: "0 6px 18px rgba(0,0,0,0.6)",
  };

  const [vehicleId, setVehicleId] = useState("AMB101");
  const [origin, setOrigin] = useState({ lat: 19.076, lon: 72.8777 });
  const [destination, setDestination] = useState({ lat: 19.2147, lon: 72.978 });

  const [originAddress, setOriginAddress] = useState("Andheri, Mumbai");
  const [destinationAddress, setDestinationAddress] = useState("Fort, Mumbai");

  const [requestId, setRequestId] = useState(null);
  const [status, setStatus] = useState(null);
  const [alternatives, setAlternatives] = useState([]);
  const [route, setRoute] = useState(null);

  const [ambulancePos, setAmbulancePos] = useState(null);
  const [loading, setLoading] = useState(false);
    const [toast, setToast] = useState(null);
  // helper to show a toast for `ms` milliseconds
  function showToast(message, ms = 4200) {
    setToast(message);
    window.setTimeout(() => {
      setToast((cur) => (cur === message ? null : cur));
    }, ms);
  }


  // ================== API helper ==================
  async function call(endpoint, method = "GET", body = null) {
    const res = await fetch(API + endpoint, {
      method,
      headers: {
        "Content-Type": "application/json",
        "x-api-key": API_KEY,
      },
      body: body ? JSON.stringify(body) : null,
    });

    if (!res.ok) throw new Error(await res.text());
    return res.json();
  }

  function LegendBox({ style }) {
    const sw = { display: "inline-block", width: 14, height: 10, marginRight: 8, borderRadius: 3, verticalAlign: "middle" };
    const row = { display: "flex", alignItems: "center", gap: 8, marginBottom: 6, fontSize: 12, color: THEME.text };

    return (
      <div style={{
        position: "absolute",
        left: 12,
        top: 12,
        zIndex: 650,
        background: "rgba(12,16,20,0.88)",
        border: "1px solid rgba(255,255,255,0.06)",
        padding: "8px 10px",
        borderRadius: 10,
        boxShadow: "0 6px 18px rgba(0,0,0,0.45)",
        fontSize: 13,
        color: THEME.text,
        ...style
      }}>
        <div style={{ fontWeight: 700, marginBottom: 6 }}>Legend</div>
        <div style={row}><span style={{ ...sw, background: "#16a34a" }} /> Low traffic (0–33%)</div>
        <div style={row}><span style={{ ...sw, background: "#eab308" }} /> Medium traffic (34–66%)</div>
        <div style={row}><span style={{ ...sw, background: "#b91c1c" }} /> Heavy traffic (67–100%)</div>
        <div style={row}><span style={{ ...sw, background: "#0ea5e9" }} /> No traffic data (dashed)</div>
        <div style={row}><svg width="18" height="8"><line x1="0" y1="6" x2="18" y2="6" stroke="#ffffff" strokeWidth="4"/></svg> Primary (thick)</div>
        <div style={row}><svg width="18" height="8"><line x1="0" y1="6" x2="18" y2="6" stroke="#ffffff" strokeWidth="2" strokeDasharray="6,6"/></svg> Alternative (thin/dashed)</div>
      </div>
    );
  }


  async function callGet(endpointWithQuery) {
    const res = await fetch(API + endpointWithQuery, {
      headers: { "x-api-key": API_KEY },
    });

    if (!res.ok) throw new Error(await res.text());
    return res.json();
  }

  // ================== Auto Center Component ==================
  function MapAutoCenter({ center }) {
    const map = useMap();

    useEffect(() => {
      if (center && Array.isArray(center)) {
        map.setView(center);
      }
    }, [center, map]);

    return null;
  }

  // ================== Geocoding ==================
  async function geocodeOrigin() {
    if (!originAddress.trim()) return alert("Enter origin address");
    try {
      setLoading(true);
      const q = encodeURIComponent(originAddress.trim());
      const geo = await callGet(`/api/geocode?address=${q}`);
      setOrigin({ lat: geo.lat, lon: geo.lon });
      setTimeout(() => setAmbulancePos({ lat: geo.lat, lon: geo.lon }), 50);
    } catch {
      alert("Failed to geocode origin");
    } finally {
      setLoading(false);
    }
  }

  async function geocodeDestination() {
    if (!destinationAddress.trim()) return alert("Enter destination address");
    try {
      setLoading(true);
      const q = encodeURIComponent(destinationAddress.trim());
      const geo = await callGet(`/api/geocode?address=${q}`);
      setDestination({ lat: geo.lat, lon: geo.lon });
      setTimeout(() => setAmbulancePos({ lat: geo.lat, lon: geo.lon }), 50);
    } catch {
      alert("Failed to geocode destination");
    } finally {
      setLoading(false);
    }
  }

  // ================== Emergency Corridor Logic ==================
  async function createRequest() {
    try {
      setLoading(true);
      const res = await call("/api/emergency/request", "POST", {
        vehicle_id: vehicleId,
        origin_lat: Number(origin.lat),
        origin_lon: Number(origin.lon),
        dest_lat: Number(destination.lat),
        dest_lon: Number(destination.lon),
        priority: "high",
      });

      if (res.request_id) {
        setRequestId(res.request_id);
        setRoute(res.route);
        setAmbulancePos({ lat: Number(origin.lat), lon: Number(origin.lon) });

        // prefer corridor_plan.alternatives but fall back to alternatives
        const alts = res.corridor_plan?.alternatives ?? res.alternatives ?? [];
        setAlternatives(alts);

        setStatus(null);
        showToast(`Corridor created • Signals synchronized • Route optimized • Traffic cleared`);


        console.log("createRequest => route", res.route);
        console.log("createRequest => alternatives", alts);
      }
    } catch (err) {
      console.error(err);
      alert("Failed to create emergency request");
    } finally {
      setLoading(false);
    }
  }
  async function updatePosition() {
    if (!requestId) return alert("Create request first!");
    try {
      setLoading(true);
      const newLat = Number(origin.lat) + (Math.random() - 0.5) * 0.01;
      const newLon = Number(origin.lon) + (Math.random() - 0.5) * 0.01;

      await call("/api/emergency/update_position", "POST", {
        request_id: requestId,
        vehicle_id: vehicleId,
        lat: newLat,
        lon: newLon,
        speed_mps: 12.3,
        bearing_deg: 88,
        ts: Date.now() / 1000,
      });

      setAmbulancePos({ lat: newLat, lon: newLon });
    } catch {
      alert("Failed to update position");
    } finally {
      setLoading(false);
    }
  }

  async function checkStatus() {
    if (!requestId) return alert("Create request first!");
    try {
      setLoading(true);
      const s = await call(`/api/emergency/status/${requestId}`, "GET");

      // route is typically at s.route
      setStatus(s);
      if (s.status === "active") showToast(`Request ${requestId || s.request_id} is active`);

      setRoute(s.route ?? s); // defensive: if server returns the route at top level sometimes

      // prefer corridor_plan.alternatives, then s.alternatives, then route.corridor_plan
      const alts =
        s.corridor_plan?.alternatives ??
        s.alternatives ??
        (s.route?.corridor_plan?.alternatives ?? s.route?.alternatives) ??
        [];
      setAlternatives(alts);

      console.log("checkStatus => route", s.route);
      console.log("checkStatus => alternatives (resolved)", alts);
    } catch (err) {
      console.error(err);
      alert("Failed to fetch status");
    } finally {
      setLoading(false);
    }
  }
  // ----------------- HELPERS (traffic colors, normalization, ETA, grouping) -----------------
  function getTrafficColor(severity_pct) {
    if (severity_pct == null || isNaN(severity_pct)) return "#0ea5e9"; // fallback blue
    const p = Number(severity_pct);
    if (p > 66) return "#b91c1c"; // red
    if (p > 33) return "#eab308"; // yellow
    return "#16a34a"; // green
  }

  // ETA uses AVG_SPEED_KMPH (40 km/h). Prefer duration_s if present.
  function etaMinutesFromRoute(routeObj) {
    if (!routeObj) return "—";
    if (routeObj.duration_s && !isNaN(routeObj.duration_s)) {
      return (Number(routeObj.duration_s) / 60).toFixed(1);
    }
    if (routeObj.distance_m && !isNaN(routeObj.distance_m)) {
      const avgSpeedMps = (AVG_SPEED_KMPH * 1000) / 3600; // 40 km/h
      const estSeconds = Number(routeObj.distance_m) / avgSpeedMps;
      return (estSeconds / 60).toFixed(1);
    }
    return "—";
  }

  // normalize a single point-like object into {lat, lon, severity}
  function normalizePoint(p) {
    if (p == null) return null;

    // array like [lat, lon] or [lon, lat]
    if (Array.isArray(p) && p.length >= 2) {
      const a0 = Number(p[0]);
      const a1 = Number(p[1]);
      if (Math.abs(a0) > 90 && Math.abs(a1) <= 90) {
        // looks like [lon, lat] -> swap
        return { lat: Number(a1), lon: Number(a0), severity: null };
      }
      return { lat: a0, lon: a1, severity: null };
    }

    // object forms
    const latRaw = p.lat ?? p.latitude ?? p.lat_deg ?? p[1] ?? p[0] ?? null;
    const lonRaw = p.lon ?? p.lng ?? p.longitude ?? p.lon_deg ?? p[0] ?? p[1] ?? null;
    const lat = Number(latRaw);
    const lon = Number(lonRaw);

    const severity =
      p.severity_pct ??
      (p.traffic && (p.traffic.severity_pct ?? p.traffic.severity)) ??
      p.traffic_severity ??
      p.segment_traffic_pct ??
      null;

    if (Number.isFinite(lat) && Number.isFinite(lon)) {
      return { lat, lon, severity: severity != null ? Number(severity) : null };
    }

    // fallback numeric keys [lon,lat] in object
    if (p[0] != null && p[1] != null) {
      const a0 = Number(p[0]);
      const a1 = Number(p[1]);
      if (Number.isFinite(a0) && Number.isFinite(a1)) {
        if (Math.abs(a0) > 90 && Math.abs(a1) <= 90) return { lat: a1, lon: a0, severity: null };
        return { lat: a0, lon: a1, severity: null };
      }
    }

    return null;
  }

  // Build per-segment polylines from different path shapes
  function buildSegmentsFromPath(maybePath) {
    if (!maybePath) return [];

    // If array of segment-like objects (each has .path/.coordinates)
    if (Array.isArray(maybePath) && maybePath.length > 0 && maybePath[0] && typeof maybePath[0] === "object" && (maybePath[0].path || maybePath[0].segment || maybePath[0].coordinates)) {
      const segments = [];
      for (const segObj of maybePath) {
        const raw = segObj.path ?? segObj.segment ?? segObj.coordinates ?? segObj.coords ?? segObj.geometry ?? [];
        const pts = (Array.isArray(raw) ? raw : []).map(normalizePoint).filter(Boolean).map(p => [p.lat, p.lon]);
        const severity =
          segObj.traffic?.severity_pct ?? segObj.severity_pct ?? segObj.segment_traffic_pct ?? null;
        if (pts.length >= 2) {
          segments.push({ pts, severity: severity != null ? Number(severity) : null });
        }
      }
      if (segments.length) return groupSegments(segments);
    }

    // If array of points -> produce adjacent segments
    if (Array.isArray(maybePath)) {
      const ptsWithMeta = maybePath.map(normalizePoint).filter(Boolean);
      if (ptsWithMeta.length >= 2) {
        const segs = [];
        for (let i = 0; i < ptsWithMeta.length - 1; i++) {
          const a = ptsWithMeta[i];
          const b = ptsWithMeta[i + 1];
          const sA = Number.isFinite(a.severity) ? a.severity : null;
          const sB = Number.isFinite(b.severity) ? b.severity : null;
          let segSeverity = null;
          if (sA != null && sB != null) segSeverity = (sA + sB) / 2;
          else if (sA != null) segSeverity = sA;
          else if (sB != null) segSeverity = sB;
          segs.push({ pts: [[a.lat, a.lon], [b.lat, b.lon]], severity: segSeverity });
        }
        return groupSegments(segs);
      }
    }

    // If object with coordinates array (GeoJSON-like)
    if (maybePath && typeof maybePath === "object") {
      const coords = maybePath.coordinates ?? maybePath.coords ?? maybePath.path ?? null;
      if (Array.isArray(coords)) return buildSegmentsFromPath(coords);
    }

    return [];
  }

  // Group consecutive small segments into larger pieces to reduce visual clutter
  function groupSegments(segments) {
    if (!Array.isArray(segments) || segments.length === 0) return [];
    const grouped = [];
    // Greedy grouping: combine next N segments
    for (let i = 0; i < segments.length; i += SEGMENT_GROUP_SIZE) {
      const slice = segments.slice(i, i + SEGMENT_GROUP_SIZE);
      // Flatten points: take start of first, then intermediate (drop duplicate points), then end of last
      const pts = [];
      for (let j = 0; j < slice.length; j++) {
        const s = slice[j];
        if (j === 0) {
          pts.push(...s.pts);
        } else {
          // avoid duplicating the first point of this segment since it's the end of previous
          pts.push(s.pts[s.pts.length - 1]);
        }
      }
      // average severity from slice (only numbers)
      const sevs = slice.map(s => s.severity).filter(s => s != null);
      const severity = sevs.length ? sevs.reduce((a,b)=>a+b,0)/sevs.length : null;
      // compress consecutive duplicate coordinates
      const cleaned = pts.filter((p, idx) => {
        if (idx === 0) return true;
        const prev = pts[idx - 1];
        return !(prev[0] === p[0] && prev[1] === p[1]);
      });
      if (cleaned.length >= 2) grouped.push({ pts: cleaned, severity });
    }
    return grouped;
  }

  // try many fields for path on route/alt objects
  function getRoutePathCandidate(routeObj) {
    if (!routeObj) return null;
    if (routeObj.path) return routeObj.path;
    if (routeObj.geometry && routeObj.geometry.coordinates) return routeObj.geometry.coordinates;
    if (routeObj.coordinates) return routeObj.coordinates;
    if (routeObj.segments) return routeObj.segments;
    if (routeObj.polyline) return decodePolylineIfNeeded(routeObj.polyline);
    if (Array.isArray(routeObj)) return routeObj;
    return null;
  }

  // optional: handle encoded polyline (many APIs use polyline strings). Very small helper:
  function decodePolylineIfNeeded(poly) {
    // If it's an array already, return it
    if (Array.isArray(poly)) return poly;
    // if it's a string and looks like encoded polyline, try to decode with a tiny decoder
    if (typeof poly === "string" && poly.length > 0) {
      try {
        // simple lightweight polyline decoder (Google encoded polyline algorithm)
        // small function included only if polyline appears to be encoded (no external deps).
        const decode = (str) => {
          let index = 0, lat = 0, lng = 0, coordinates = [];
          while (index < str.length) {
            let b, shift = 0, result = 0;
            do {
              b = str.charCodeAt(index++) - 63;
              result |= (b & 0x1f) << shift;
              shift += 5;
            } while (b >= 0x20);
            const dlat = ((result & 1) ? ~(result >> 1) : (result >> 1));
            lat += dlat;
            shift = 0;
            result = 0;
            do {
              b = str.charCodeAt(index++) - 63;
              result |= (b & 0x1f) << shift;
              shift += 5;
            } while (b >= 0x20);
            const dlng = ((result & 1) ? ~(result >> 1) : (result >> 1));
            lng += dlng;
            coordinates.push([lat / 1e5, lng / 1e5]);
          }
          return coordinates;
        };
        return decode(poly);
      } catch (e) {
        return null;
      }
    }
    return null;
  }

  // ================== Derived Map Data ==================
  const mapCenter = useMemo(() => {
    if (ambulancePos) return [ambulancePos.lat, ambulancePos.lon];
    return [Number(origin.lat), Number(origin.lon)];
  }, [ambulancePos, origin]);

  const polylinePoints = useMemo(() => {
    if (route?.path?.length) {
      return route.path.map((p) => {
        const lat = Number(p.lat ?? p.latitude ?? (Array.isArray(p) ? p[0] : NaN));
        const lon = Number(p.lon ?? p.lng ?? p.longitude ?? (Array.isArray(p) ? p[1] : NaN));
        if (Number.isFinite(lat) && Number.isFinite(lon)) return [lat, lon];
        return null;
      }).filter(Boolean);
    }
    const pts = [];
    if (origin) pts.push([Number(origin.lat), Number(origin.lon)]);
    if (route?.intersections)
      route.intersections.forEach((i) => pts.push([i.lat, i.lon]));
    if (destination) pts.push([Number(destination.lat), Number(destination.lon)]);
    return pts;
  }, [origin, destination, route]);

  // ================== UI ==================
  return (
    <div
      className="ec-root"
      style={{
        minHeight: "100vh",
        background: THEME.bg,
        padding: "24px 32px",
        fontFamily:
          "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
        color: THEME.text,
      }}
    >

      {toast && (
        <div
          aria-live="polite"
          style={{
            position: "fixed",
            right: 20,
            top: 20,
            zIndex: 9999,
            background: "linear-gradient(90deg, #16a34a, #059669)",
            color: "#fff",
            padding: "10px 14px",
            borderRadius: 10,
            boxShadow: "0 8px 28px rgba(5,64,29,0.45)",
            fontWeight: 700,
            minWidth: 220,
            textAlign: "center",
          }}
        >
          {toast}
        </div>
      )}


      <style>{`
        .ec-root input::placeholder { color: rgba(230,238,243,0.45); }
        .ec-root .leaflet-container { background: ${THEME.bg}; z-index: 0; }
        .ec-root .leaflet-tooltip {
          background: rgba(10,12,15,0.85) !important;
          color: #fff !important;
          border: 1px solid rgba(255,255,255,0.04) !important;
          box-shadow: 0 6px 18px rgba(0,0,0,0.6);
        }
        .ec-root .leaflet-popup-content-wrapper { background: ${THEME.cardBg}; color: ${THEME.text}; }
        .ec-root .leaflet-control { color: ${THEME.text}; }
        .ec-root .leaflet-marker-icon { filter: drop-shadow(0 2px 4px rgba(0,0,0,0.8)); }
      `}</style>

      <h1 style={{ fontSize: "28px", fontWeight: 700, marginBottom: "10px" }}>
        🚨 Emergency Corridor Dashboard
      </h1>

      <p style={{ marginBottom: "20px", color: THEME.muted }}>
        Type addresses, generate a real road corridor, and track the ambulance along the route.
      </p>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(0, 420px) minmax(0, 1fr)",
          gap: "24px",
        }}
      >
        {/* LEFT PANEL */}
        <div>
          <div style={card}>
            <h2 style={cardTitle}>🚑 Vehicle & Route Setup</h2>

            <div style={fieldGroup}>
              <label style={label}>Vehicle ID</label>
              <input
                type="text"
                value={vehicleId}
                onChange={(e) => setVehicleId(e.target.value)}
                style={input}
              />
            </div>

            <div style={fieldGroup}>
              <label style={label}>Origin Address</label>
              <div style={{ display: "flex", gap: "8px" }}>
                <input
                  type="text"
                  value={originAddress}
                  onChange={(e) => setOriginAddress(e.target.value)}
                  style={input}
                />
                <button style={chipBtn} onClick={geocodeOrigin} disabled={loading}>
                  Use
                </button>
              </div>
            </div>

            <div style={fieldGroup}>
              <label style={label}>Destination Address</label>
              <div style={{ display: "flex", gap: "8px" }}>
                <input
                  type="text"
                  value={destinationAddress}
                  onChange={(e) => setDestinationAddress(e.target.value)}
                  style={input}
                />
                <button
                  style={chipBtn}
                  onClick={geocodeDestination}
                  disabled={loading}
                >
                  Use
                </button>
              </div>
            </div>

            <div style={fieldGroup}>
              <label style={label}>Origin (lat, lon)</label>
              <div style={{ display: "flex", gap: "8px" }}>
                <input
                  value={origin.lat}
                  onChange={(e) => setOrigin({ ...origin, lat: e.target.value })}
                  style={inputHalf}
                />
                <input
                  value={origin.lon}
                  onChange={(e) => setOrigin({ ...origin, lon: e.target.value })}
                  style={inputHalf}
                />
              </div>
            </div>

            <div style={fieldGroup}>
              <label style={label}>Destination (lat, lon)</label>
              <div style={{ display: "flex", gap: "8px" }}>
                <input
                  value={destination.lat}
                  onChange={(e) =>
                    setDestination({ ...destination, lat: e.target.value })
                  }
                  style={inputHalf}
                />
                <input
                  value={destination.lon}
                  onChange={(e) =>
                    setDestination({ ...destination, lon: e.target.value })
                  }
                  style={inputHalf}
                />
              </div>
            </div>

            <div style={{ display: "flex", gap: "10px", marginTop: "12px" }}>
              <button onClick={createRequest} style={primaryBtn} disabled={loading}>
                {loading ? "Please wait..." : "Create Corridor"}
              </button>

              <button
                onClick={updatePosition}
                style={secondaryBtn}
                disabled={!requestId || loading}
              >
                Send GPS Update
              </button>
            </div>

            {requestId && (
              <p style={{ marginTop: "12px", fontSize: "13px", color: THEME.muted }}>
                Active Request ID:{" "}
                <span style={{ color: "#2563eb", fontWeight: 600 }}>{requestId}</span>
              </p>
            )}
          </div>

          <div style={{ ...card, marginTop: "16px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <h2 style={cardTitle}>📊 Corridor Status</h2>
              <button
                onClick={checkStatus}
                style={{ ...secondaryBtn, padding: "6px 10px", fontSize: "12px" }}
                disabled={!requestId || loading}
              >
                Refresh
              </button>
            </div>

            {!status && (
              <p style={{ fontSize: "13px", color: THEME.muted }}>
                No status fetched yet. Create a corridor and click “Refresh”.
              </p>
            )}

           {status && (
              <>
                <p style={{ fontSize: "14px" }}>
                  Status:{" "}
                  <span
                    style={{
                      fontWeight: 600,
                      color: status.status === "active" ? "#059669" : "#b91c1c",
                    }}
                  >
                    {status.status}
                  </span>
                </p>

                <p style={{ fontSize: "13px", color: THEME.muted }}>
                  Distance:{" "}
                  {status.route
                    ? `${(status.route.distance_m / 1000).toFixed(2)} km`
                    : "—"}
                  {" · "}
                  ETA:{" "}
                  {status.route
                    ? `${(status.route.duration_s / 60).toFixed(1)} min`
                    : `${etaMinutesFromRoute(status.route)} min`}
                </p>

                {status.route?.traffic && (
                  <p style={{ fontSize: "13px", color: THEME.muted }}>
                    Primary route traffic:{" "}
                    <span
                      style={{
                        fontWeight: 600,
                        color:
                          status.route.traffic.severity_pct > 50
                            ? "#b91c1c"
                            : status.route.traffic.severity_pct > 30
                            ? "#eab308"
                            : "#059669",
                      }}
                    >
                      {status.route.traffic.severity_pct.toFixed(1)}%
                    </span>
                  </p>
                )}

                {alternatives && alternatives.length > 0 && (
                  <div style={{ marginTop: "10px" }}>
                    <p
                      style={{
                        fontSize: "12px",
                        color: THEME.muted,
                        marginBottom: "4px",
                      }}
                    >
                      Alternative routes:
                    </p>
                    <ul
                      style={{
                        listStyle: "none",
                        paddingLeft: 0,
                        margin: 0,
                        fontSize: "12px",
                      }}
                    >
                      {alternatives.map((alt, idx) => (
                        <li
                          key={alt.id || idx}
                          style={{ marginBottom: "4px", lineHeight: 1.5 }}
                        >
                          <strong>{`Alt ${idx + 1}`}</strong>{" "}
                          – dist{" "}
                          {alt.route?.distance_m
                            ? `${(alt.route.distance_m / 1000).toFixed(2)} km`
                            : "—"}
                          , ETA{" "}
                          {alt.route?.duration_s
                            ? `${(alt.route.duration_s / 60).toFixed(1)} min`
                            : `${etaMinutesFromRoute(alt.route)} min`}
                          , traffic{" "}
                          {alt.traffic?.severity_pct != null
                            ? `${alt.traffic.severity_pct.toFixed(1)}%`
                            : "—"}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {status.intersections && (
                  <ul style={{ listStyle: "none", paddingLeft: 0, marginTop: "10px", fontSize: "13px" }}>
                    {status.intersections.map((i, idx) => {
                      const now = Date.now() / 1000;
                      let timeRemainingSec = null;
                      if (i.eta_epoch && !isNaN(i.eta_epoch)) {
                        timeRemainingSec = Math.max(0, Math.round(i.eta_epoch - now));
                      } else if (i.eta_s && !isNaN(i.eta_s)) {
                        // if server gave only relative seconds, it's relative to creation; show it as relative ETA
                        timeRemainingSec = Math.max(0, Math.round(i.eta_s));
                      }
                      const display = timeRemainingSec != null ? `${timeRemainingSec} s` : "—";
                      return (
                        <li key={i.id} style={{ marginBottom: "4px" }}>
                          <strong>#{idx + 1} {i.id}</strong> – lat: {Number(i.lat).toFixed(4)}, lon: {Number(i.lon).toFixed(4) }
                        </li>
                      );
                    })}
                  </ul>
                )}

              </>
            )}

          </div>
        </div>

        {/* RIGHT PANEL — MAP */}
        <div style={{ height: "520px" }}>
          <div style={{ ...card, height: "100%", padding: 0 }}>
            <div style={{ padding: "12px 16px", borderBottom: `1px solid ${THEME.border}` }}>
              <h2 style={{ ...cardTitle, marginBottom: 0 }}>🗺️ Corridor Map</h2>
              <p style={{ fontSize: "12px", color: THEME.muted }}>
                Colored segments show traffic severity (green/yellow/red). Dashed = no data.
              </p>
            </div>

            <MapContainer
              center={mapCenter}
              zoom={12}
              style={{ height: "100%", width: "100%" }}
            >
              <MapAutoCenter center={mapCenter} />
              <LegendBox style={{ top: 60 }} />

              <TileLayer
                url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
                attribution='&copy; <a href="https://carto.com/attributions">CARTO</a> &copy; OpenStreetMap contributors'
              />

              {/* Primary route as grouped segments */}
              {(() => {
                const pathCandidate = getRoutePathCandidate(route);
                const primarySegments = buildSegmentsFromPath(pathCandidate ?? route?.path ?? polylinePoints);
                if (primarySegments && primarySegments.length > 0) {
                  return primarySegments.map((seg, i) => (
                    <Polyline
                      key={`primary-seg-${i}`}
                      positions={seg.pts}
                      pathOptions={{
                        color: seg.severity != null ? getTrafficColor(seg.severity) : getTrafficColor(route?.traffic?.severity_pct),
                        weight: 6,
                        opacity: 0.95,
                        dashArray: seg.severity == null ? "6 6" : undefined,
                      }}
                    >
                      <Tooltip>
                        {seg.severity != null ? `Primary segment · ${Number(seg.severity).toFixed(1)}% traffic` : route?.traffic?.severity_pct != null ? `Primary · ${route.traffic.severity_pct.toFixed(1)}% traffic` : "Primary · no traffic data"}
                      </Tooltip>
                    </Polyline>
                  ));
                }
                return null;
              })()}

              {/* Markers */}
              <Marker position={[Number(origin.lat), Number(origin.lon)]}>
                <Tooltip permanent>Origin</Tooltip>
              </Marker>

              <Marker position={[Number(destination.lat), Number(destination.lon)]}>
                <Tooltip permanent>Destination</Tooltip>
              </Marker>

              {route?.intersections?.map((i) => (
                <Marker key={i.id} position={[Number(i.lat), Number(i.lon)]}>
                  <Tooltip permanent>{i.id}</Tooltip>
                </Marker>
              ))}

              {ambulancePos && (
                <Marker position={[Number(ambulancePos.lat), Number(ambulancePos.lon)]}>
                  <Tooltip permanent>🚑 Ambulance</Tooltip>
                </Marker>
              )}

              {/* Alternatives: each alt broken into grouped segments */}
             {alternatives &&
                alternatives.map((alt, altIdx) => {
                  const candidate = getRoutePathCandidate(alt.route ?? alt) ?? (alt.route ? alt.route.path ?? alt.route.segments : null) ?? alt.path ?? alt.segments ?? alt;
                  const altSegments = buildSegmentsFromPath(candidate);
                  if (!altSegments || altSegments.length === 0) return null;

                  // simple duplicate check: compare midpoints to primary route midpoint (if route exists)
                  const primaryMid = (route && route.path && route.path.length) ? route.path[Math.floor(route.path.length/2)] : null;
                  const altMid = (candidate && candidate.length) ? candidate[Math.floor(candidate.length/2)] : null;
                  if (primaryMid && altMid) {
                    const pmLat = primaryMid.lat ?? primaryMid[0] ?? null;
                    const pmLon = primaryMid.lon ?? primaryMid[1] ?? null;
                    const amLat = altMid.lat ?? altMid[0] ?? null;
                    const amLon = altMid.lon ?? altMid[1] ?? null;
                    if (pmLat != null && pmLon != null && amLat != null && amLon != null) {
                      // if midpoint separation < ~25 meters, consider it duplicate and skip rendering
                      const metersApart = (latlon1, latlon2) => {
                        const toRad = (v) => (v * Math.PI) / 180.0;
                        const R = 6371000;
                        const dLat = toRad(latlon2[0] - latlon1[0]);
                        const dLon = toRad(latlon2[1] - latlon1[1]);
                        const a = Math.sin(dLat/2) * Math.sin(dLat/2) + Math.cos(toRad(latlon1[0])) * Math.cos(toRad(latlon2[0])) * Math.sin(dLon/2) * Math.sin(dLon/2);
                        return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
                      };
                      if (metersApart([Number(pmLat), Number(pmLon)], [Number(amLat), Number(amLon)]) < 25) {
                        return null; // too similar to primary
                      }
                    }
                  }

                  const ALT_COLORS = ["#60a5fa", "#0ea5e9", "#7c3aed", "#06b6d4"];

                  const color = ALT_COLORS[altIdx % ALT_COLORS.length];

                  return (
                    <span key={`alt-wrap-${alt.id || altIdx}`}>
                      {altSegments.map((seg, i) => (
                        <Polyline
                          key={`alt-${altIdx}-seg-${i}`}
                          positions={seg.pts}
                          pathOptions={{
                            color: seg.severity != null ? getTrafficColor(seg.severity) : getTrafficColor(alt.traffic?.severity_pct ?? alt.route?.traffic?.severity_pct) || color,
                            weight: 4,
                            opacity: 0.95,
                            dashArray: seg.severity == null ? "6 6" : undefined,
                          }}
                        >
                          <Tooltip>
                            {`Alt ${altIdx + 1} · ETA: ${alt.route?.duration_s ? (Number(alt.route.duration_s)/60).toFixed(1)+" min" : `${etaMinutesFromRoute(alt.route)} min`}`}
                            {seg.severity != null ? ` · ${Number(seg.severity).toFixed(1)}% traffic` : alt.traffic?.severity_pct != null ? ` · ${alt.traffic.severity_pct.toFixed(1)}% traffic` : " · no traffic data"}
                          </Tooltip>
                        </Polyline>
                      ))}
                    </span>
                  );
                })}

              {customBoundaryGeoJson && (
                <GeoJSON
                  data={customBoundaryGeoJson}
                  style={{ color: "#ffffff", weight: 2, opacity: 0.7, fill: false }}
                />
              )}

            </MapContainer>
            <div style={{ padding: "12px 16px", borderTop: `1px solid ${THEME.border}`, background: "#061019", color: THEME.text }}>
              <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>How It Works</h3>
              <ol style={{ marginTop: 8, paddingLeft: 18, color: THEME.muted, fontSize: 13 }}>
                <li style={{ marginBottom: 6 }}>Emergency vehicle detected via GPS or operator input.</li>
                <li style={{ marginBottom: 6 }}>Server computes an optimized corridor and alternatives in real-time.</li>
                <li style={{ marginBottom: 6 }}>Traffic signals and authorities are notified to clear the corridor.</li>
                <li style={{ marginBottom: 6 }}>Ambulance tracked live; route monitored until completion.</li>
              </ol>
            </div>

          </div>
        </div>
      </div>
    </div>
  );
}

/* --- styles --- */
const card = {
  background: "#0b1116",
  borderRadius: "16px",
  padding: "16px 18px",
  boxShadow: "0 6px 18px rgba(0,0,0,0.6)",
  border: "1px solid rgba(255,255,255,0.06)",
};

const cardTitle = {
  fontSize: "16px",
  fontWeight: 600,
  color: "#E6EEF3",
  marginBottom: "8px",
};

const fieldGroup = { marginBottom: "10px" };

const label = {
  fontSize: "12px",
  fontWeight: 500,
  color: "#9CA3AF",
  marginBottom: "4px",
  display: "block",
};

const input = {
  width: "100%",
  padding: "7px 9px",
  borderRadius: "8px",
  border: "1px solid rgba(255,255,255,0.06)",
  background: "#0f1720",
  color: "#E6EEF3",
  fontSize: "13px",
  outline: "none",
};

const inputHalf = {
  flex: 0.7,
  padding: "7px 9px",
  borderRadius: "8px",
  border: "1px solid rgba(255,255,255,0.06)",
  background: "#0f1720",
  color: "#E6EEF3",
  fontSize: "13px",
};

const primaryBtn = {
  padding: "8px 14px",
  borderRadius: "999px",
  border: "none",
  fontSize: "13px",
  fontWeight: 600,
  cursor: "pointer",
  background: "#2563eb",
  color: "white",
  boxShadow: "0 6px 16px rgba(37,99,235,0.16)",
};

const secondaryBtn = {
  padding: "8px 14px",
  borderRadius: "999px",
  border: "1px solid rgba(255,255,255,0.06)",
  fontSize: "13px",
  fontWeight: 500,
  cursor: "pointer",
  background: "transparent",
  color: "#E6EEF3",
};

const chipBtn = {
  padding: "6px 10px",
  borderRadius: "999px",
  border: "none",
  fontSize: "12px",
  fontWeight: 600,
  cursor: "pointer",
  background: "transparent",
  color: "#E6EEF3",
};
