// src/pages/MapView.jsx  (DROP-IN REPLACEMENT)
// - Highlights India polygon and masks the rest of the world.
// - Use a local file public/india.geojson (preferred) OR fallback to DataHub countries GeoJSON.
// - Preserves existing traffic/road logic; road names & tooltips are white.

import React, { useEffect, useState, useRef } from "react";
import {
  MapContainer,
  TileLayer,
  Polyline,
  Popup,
  Tooltip,
  useMap,
  GeoJSON,
} from "react-leaflet";
import { getRoads, getLiveTraffic } from "../api";

const DARK_TILE_URL = "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png";
const DARK_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &amp; CartoDB';

// fallback country GeoJSON (DataHub). If network blocked, supply local public/india.geojson
const FALLBACK_COUNTRIES_GEOJSON =
  "https://datahub.io/core/geo-countries/r/countries.geojson";

const severityColor = (sev) =>
  sev < 33 ? "#34d399" : sev < 66 ? "#f59e0b" : "#fb7185"; // green / amber / red

const fontFamily = "'Red Hat Display', sans-serif";

function normalizeRoads(roads, limit) {
  const valid = (roads || []).filter(
    (r) => Array.isArray(r.coordinates) && r.coordinates.length > 0
  );

  const named = [];
  const unnamed = [];

  for (const r of valid) {
    const name = (r.name || "").trim();
    if (!name || /^unnamed/i.test(name)) {
      unnamed.push(r);
    } else {
      named.push(r);
    }
  }

  const byLengthDesc = (a, b) =>
    (b.coordinates?.length || 0) - (a.coordinates?.length || 0);

  named.sort(byLengthDesc);
  unnamed.sort(byLengthDesc);

  return named.concat(unnamed).slice(0, limit);
}

// paste somewhere above loadMapData
async function fetchCO2ForCity(cityName) {
  try {
    const apiKey = "9505fd1df737e20152fbd78cdb289b6a"; // keep secret in real app
    if (!apiKey) {
      console.warn("OpenWeather API key is missing");
      return null;
    }

    const geoRes = await fetch(
      `https://api.openweathermap.org/geo/1.0/direct?q=${encodeURIComponent(
        cityName
      )}&limit=1&appid=${apiKey}`
    );
    const geoData = await geoRes.json();
    if (!Array.isArray(geoData) || geoData.length === 0) {
      console.warn("No geocoding result for city", cityName);
      return null;
    }

    const { lat, lon } = geoData[0];

    const airRes = await fetch(
      `https://api.openweathermap.org/data/2.5/air_pollution?lat=${lat}&lon=${lon}&appid=${apiKey}`
    );
    const airData = await airRes.json();
    const first = airData?.list?.[0];
    const components = first?.components;

    const co = components?.co; // μg/m³
    if (co == null) return null;

    // CO + 1/2 O2 -> CO2 : convert mass proportionally
    const CO_MOLAR_MASS = 28;
    const CO2_MOLAR_MASS = 44;
    const factor = CO2_MOLAR_MASS / CO_MOLAR_MASS; // ≈ 1.5714

    const co2FromCo = co * factor;

    return {
      co,         // original CO
      co2FromCo,  // hypothetical CO2 (μg/m³)
    };
  } catch (err) {
    console.error("Failed to fetch CO/CO2 from OpenWeather", err);
    return null;
  }
}


function FitBounds({ coords }) {
  const map = useMap();
  useEffect(() => {
    if (coords && coords.length) {
      const latlngs = coords.flat();
      map.fitBounds(latlngs, { padding: [60, 60] });
      const z = map.getZoom();
      if (z < 8) map.setZoom(8);
      if (z > 17) map.setZoom(17);
    }
  }, [coords, map]);
  return null;
}

/**
 * Build a "mask polygon" GeoJSON feature that covers the whole world except the given indiaPolys.
 * Leaflet / GeoJSON supports polygons with holes: outer ring followed by hole rings.
 * For MultiPolygon indiaPolys, we create one MultiPolygon mask by composing outer rectangle and inner rings.
 */
function buildIndiaMaskGeoJSON(indiaFeature) {
  // outer ring: a big rectangle (lon,lat in GeoJSON order)
  // use coords in [lon,lat] order for GeoJSON
  const outer = [
    [
      [-180, -90],
      [180, -90],
      [180, 90],
      [-180, 90],
      [-180, -90],
    ],
  ];

  if (!indiaFeature) return null;

  const geom = indiaFeature.geometry;
  if (!geom) return null;

  if (geom.type === "Polygon") {
    // convert india polygon rings to GeoJSON: rings must be lon/lat
    const indiaRings = geom.coordinates.map((ring) =>
      ring.map((pt) => [pt[0], pt[1]])
    );
    // mask polygon with hole(s): outer ring then hole rings
    const maskPoly = {
      type: "Feature",
      properties: { name: "mask" },
      geometry: { type: "Polygon", coordinates: [outer[0].slice(), ...indiaRings] },
    };
    return maskPoly;
  } else if (geom.type === "MultiPolygon") {
    // For MultiPolygon, create a FeatureCollection of masked polygons (one per outer polygon).
    // We'll create one polygon with multiple holes per each sub-polygon by using outer ring and each subpoly as hole.
    // Simpler: return a FeatureCollection with one Polygon mask per sub-polygon.
    const features = geom.coordinates.map((mp) => {
      // mp is array of rings for a polygon
      const rings = mp.map((ring) => ring.map((pt) => [pt[0], pt[1]]));
      return {
        type: "Feature",
        properties: { name: "mask" },
        geometry: { type: "Polygon", coordinates: [outer[0].slice(), ...rings] },
      };
    });
    return { type: "FeatureCollection", features };
  }
  return null;
}

export default function MapView() {
  const [center, setCenter] = useState([19.076, 72.8777]);
  const [roads, setRoads] = useState([]);
  const [severity, setSeverity] = useState({});
  const [loading, setLoading] = useState(true);
  const coordsRef = useRef(null);
  const [co2Value, setCo2Value] = useState(null);


  // indiaGeo - the India polygon feature (GeoJSON feature)
  const [indiaFeature, setIndiaFeature] = useState(null);
  const [maskGeo, setMaskGeo] = useState(null);
  const [borderGeo, setBorderGeo] = useState(null);

  const [city, setCity] = useState(() => {
    if (typeof window !== "undefined") {
      return localStorage.getItem("trafficCity") || "Kolkata";
    }
    return "Kolkata";
  });

  const [segmentsNum, setSegmentsNum] = useState(() => {
    if (typeof window !== "undefined") {
      const v = localStorage.getItem("trafficSegments");
      if (v != null && !Number.isNaN(Number(v))) return Number(v);
    }
    return 5;
  });

  const [timeSteps, setTimeSteps] = useState(() => {
    if (typeof window !== "undefined") {
      const v = localStorage.getItem("trafficTimeSteps");
      if (v != null && !Number.isNaN(Number(v))) return Number(v);
    }
    return 10;
  });

  // ensure page background dark
  useEffect(() => {
    document.documentElement.style.background = "#020617";
    document.body.style.background = "#020617";
    const styleElId = "mapview-dark-style";
    if (!document.getElementById(styleElId)) {
      const css = `
        .leaflet-container { background: #0b1220 !important; }
        .leaflet-control-container .leaflet-control-attribution { color: rgba(255,255,255,0.6) !important; }
        .leaflet-popup-content-wrapper, .leaflet-popup-content { background: #071227 !important; color: #fff !important; }
      `;
      const s = document.createElement("style");
      s.id = styleElId;
      s.appendChild(document.createTextNode(css));
      document.head.appendChild(s);
    }
  }, []);

  // load India polygon: prefer a local file public/india.geojson (more authoritative)
  useEffect(() => {
    let cancelled = false;
    async function fetchIndia() {
      // try local first
      const localUrl = "/india.geojson";
      try {
        const rlocal = await fetch(localUrl, { cache: "no-cache" });
        if (rlocal.ok) {
          const j = await rlocal.json();
          if (!cancelled) {
            // find the first feature (or feature with name India)
            let feat = null;
            if (j.type === "FeatureCollection") {
              feat = j.features?.find(
                (f) =>
                  (f.properties?.ADMIN || f.properties?.admin || f.properties?.NAME || "")
                    .toString()
                    .toLowerCase()
                    .includes("india")
              );
              if (!feat) feat = j.features && j.features.length ? j.features[0] : null;
            } else if (j.type === "Feature") {
              feat = j;
            }
            if (feat) {
              setIndiaFeature(feat);
              setBorderGeo(feat);
              const mask = buildIndiaMaskGeoJSON(feat);
              setMaskGeo(mask);
              return;
            }
          }
        }
      } catch (e) {
        // ignore local error and fall back
      }

      // fallback: fetch countries dataset and pick India feature
      try {
        const rf = await fetch(FALLBACK_COUNTRIES_GEOJSON, { cache: "no-cache" });
        if (!rf.ok) return;
        const jf = await rf.json();
        if (cancelled) return;
        if (jf.type === "FeatureCollection") {
          // common property names: ADMIN, NAME, name
          const feat =
            jf.features.find(
              (f) =>
                (f.properties?.ADMIN || f.properties?.NAME || f.properties?.name || "")
                  .toString()
                  .toLowerCase()
                  .includes("india")
            ) || jf.features.find((f) => (f.properties?.ISO_A3 || "").toString() === "IND");
          if (feat) {
            setIndiaFeature(feat);
            setBorderGeo(feat);
            const mask = buildIndiaMaskGeoJSON(feat);
            setMaskGeo(mask);
          }
        }
      } catch (err) {
        // silent
      }
    }
    fetchIndia();
    return () => {
      cancelled = true;
    };
  }, []);

  const loadMapData = async (cityArg, segmentsArg, timeStepsArg) => {
    setLoading(true);
    try {
      // fetch roads and CO data in parallel
      const [r, co2] = await Promise.all([
        getRoads(cityArg, segmentsArg * 3),
        fetchCO2ForCity(cityArg),
      ]);

      const raw = r.data?.roads || [];
      const list = normalizeRoads(raw, segmentsArg);
      setRoads(list);

      // set CO2 result
      setCo2Value(co2 || null);

      // rest of existing code...
      if (list.length) {
        coordsRef.current = list.map((x) => x.coordinates);
        const c = list[0].coordinates[0];
        setCenter([c[0], c[1]]);
      } else {
        coordsRef.current = null;
      }


      const sevMap = {};
      await Promise.all(
        list.slice(0, 40).map(async (road) => {
          try {
            const coords = road.coordinates || [];
            const mid = coords[Math.floor(coords.length / 2)] || coords[0] || [0, 0];
            const lat = mid[0];
            const lon = mid[1];
            const t = await getLiveTraffic(road.id, lat, lon, city);
            const s = t.data?.severity ?? Math.round((t.data?.jamFactor ?? 0) * 10 * 10);
            sevMap[road.id] = s;
          } catch {
            sevMap[road.id] = 0;
          }
        })
      );
      setSeverity(sevMap);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadMapData(city, segmentsNum, timeSteps);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleCopy = (id) => {
    try {
      navigator.clipboard?.writeText(id);
      alert("Copied: " + id);
    } catch {
      // ignore
    }
  };

  const handleSearch = (e) => {
    e.preventDefault();
    if (typeof window !== "undefined") {
      localStorage.setItem("trafficCity", city);
      localStorage.setItem("trafficSegments", String(segmentsNum));
      localStorage.setItem("trafficTimeSteps", String(timeSteps));
    }
    loadMapData(city, segmentsNum, timeSteps);
  };

  // border style / mask style
  const borderStyle = { color: "#ffffff", weight: 2.5, opacity: 0.95 };
  const maskStyle = { color: "#000000", fillColor: "#000000", fillOpacity: 0.55, opacity: 0.0 };

  return (
    <div
      style={{
        height: "80vh",
        display: "flex",
        flexDirection: "column",
        background: "#020617",
        color: "#f9fafb",
        fontFamily,
      }}
    >
      <div
        style={{
          padding: "18px 26px 14px",
          borderBottom: "1px solid rgba(255,255,255,0.04)",
          display: "flex",
          alignItems: "center",
          gap: 24,
          flexWrap: "wrap",
          background: "linear-gradient(180deg, #05060a 0%, #071025 100%)",
          fontFamily,
        }}
      >
        <h2 style={{ margin: 0, fontSize: 26, fontWeight: 700, color: "#fff", fontFamily }}>
          Traffic Dashboard
        </h2>

        <form onSubmit={handleSearch} style={{ display: "flex", gap: 18, alignItems: "center" }}>
          <label style={{ display: "flex", alignItems: "center", gap: 8, color: "#cbd5e1" }}>
            <span>City</span>
            <input
              style={{
                borderRadius: 9999,
                padding: "8px 14px",
                border: "1px solid rgba(255,255,255,0.06)",
                background: "#071227",
                color: "#f8fafc",
                outline: "none",
                minWidth: 150,
              }}
              value={city}
              onChange={(e) => setCity(e.target.value)}
            />
          </label>

          <label style={{ display: "flex", alignItems: "center", gap: 8, color: "#cbd5e1" }}>
            <span>Segments</span>
            <input
              type="number"
              min={1}
              max={999}
              value={segmentsNum}
              onChange={(e) => setSegmentsNum(Number(e.target.value))}
              style={{
                borderRadius: 9999,
                padding: "8px 14px",
                border: "1px solid rgba(255,255,255,0.06)",
                background: "#071227",
                color: "#f8fafc",
                width: 80,
                textAlign: "center",
              }}
            />
          </label>

          <label style={{ display: "flex", alignItems: "center", gap: 8, color: "#cbd5e1" }}>
            <span>Time steps</span>
            <input
              type="number"
              min={3}
              max={999}
              value={timeSteps}
              onChange={(e) => setTimeSteps(Number(e.target.value))}
              style={{
                borderRadius: 9999,
                padding: "8px 14px",
                border: "1px solid rgba(255,255,255,0.06)",
                background: "#071227",
                color: "#f8fafc",
                width: 80,
                textAlign: "center",
              }}
            />
          </label>

          <button
            type="submit"
            disabled={loading}
            style={{
              borderRadius: 9999,
              padding: "9px 22px",
              border: "none",
              background: "linear-gradient(135deg,#4f46e5,#2563eb)",
              color: "#fff",
              fontWeight: 700,
            }}
          >
            {loading ? "LOADING..." : "UPDATE"}
          </button>
        </form>
      </div>

      <div style={{ flex: 1 }}>
        <MapContainer center={center} zoom={12} style={{ height: "100%" }}>
          <TileLayer url={DARK_TILE_URL} attribution={DARK_ATTRIBUTION} />

          {/* mask the outside-of-India area by drawing a polygon with hole(s) built earlier */}
          {maskGeo && maskGeo.type === "Feature" && (
            <GeoJSON data={maskGeo} style={maskStyle} />
          )}
          {maskGeo && maskGeo.type === "FeatureCollection" &&
            maskGeo.features.map((f, idx) => <GeoJSON key={`mask-${idx}`} data={f} style={maskStyle} />)}

          {/* draw India border on top */}
          {borderGeo && <GeoJSON data={borderGeo} style={borderStyle} />}

          {/* roads */}
          {roads.map((road) => {
            const latlngs = road.coordinates.map((c) => [c[0], c[1]]);
            const sev = severity[road.id] ?? 20;
            return (
              <Polyline
                key={road.id}
                positions={latlngs}
                pathOptions={{
                  color: severityColor(sev),
                  weight: Math.max(3, Math.min(8, Math.round(sev / 15))),
                  opacity: 0.98,
                }}
              >
                <Popup>
                  <div style={{ minWidth: 200, background: "#071227", color: "#fff", padding: 10, borderRadius: 6 }}>
                    <b style={{ display: "block", fontSize: 15, color: "#ffffff" }}>{road.name || "Unnamed"}</b>
                    <div style={{ marginTop: 6 }}>
                      <small style={{ color: "#aab4c2" }}>ID: {road.id}</small>
                    </div>
                    <div style={{ marginTop: 10 }}>
                      <button
                        onClick={() => handleCopy(road.id)}
                        style={{
                          padding: "6px 10px",
                          borderRadius: 6,
                          border: "none",
                          background: "rgba(255,255,255,0.06)",
                          color: "#f8fafc",
                          cursor: "pointer",
                        }}
                      >
                        Copy ID
                      </button>
                    </div>

                    <div style={{ marginTop: 6, color: "#d1e3f0", fontSize: 13, lineHeight: 1.1 }}>
                        {co2Value ? (
                          <>
                            <div style={{ marginBottom: 4 }}>
                              <span style={{ opacity: 0.9 }}>CO:</span>{" "}
                              <strong style={{ color: "#fff" }}>{co2Value.co.toFixed(0)}</strong>{" "}
                              <span style={{ color: "#9fb1c9" }}>μg/m³</span>
                            </div>
                            <div>
                              <span style={{ opacity: 0.9 }}>CO₂:</span>{" "}
                              <strong style={{ color: "#fff" }}>{co2Value.co2FromCo.toFixed(0)}</strong>{" "}
                              <span style={{ color: "#9fb1c9" }}>μg/m³</span>
                            </div>
                          </>
                        ) : (
                          <div style={{ color: "#9fb1c9" }}>Air data: —</div>
                        )}
                    </div>

                  </div>
                </Popup>
                <Tooltip direction="top" sticky>
                  <div style={{ color: "#fff", background: "rgba(0,0,0,0.5)", padding: "2px 6px", borderRadius: 4 }}>
                    {road.name || "Unnamed"}
                  </div>
                </Tooltip>
              </Polyline>
            );
          })}

          {!loading && coordsRef.current && coordsRef.current.length > 0 && <FitBounds coords={coordsRef.current} />}
        </MapContainer>
      </div>
    </div>
  );
}
