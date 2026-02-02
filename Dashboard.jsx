// src/pages/Dashboard.jsx
import React, { useEffect, useState, useMemo } from "react";
import { getRoads, getLiveTraffic, predictToday } from "../api";

import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  LineChart,
  Line,
} from "recharts";
import clsx from "clsx";
import "./Dashboard.css";

function levelFor(v) {
  if (v < 30) return { label: "Low", color: "green" };
  if (v < 70) return { label: "Medium", color: "orange" };
  return { label: "High", color: "red" };
}

// ---------- NEW: prettify road name ----------
function prettifyRoadName(raw = "", { short = false, maxLen = 18 } = {}) {
  if (!raw) return "";

  // common noisy prefixes / suffixes to remove
  let s = raw;

  // remove technical prefixes
  s = s.replace(/^merged[_\-\.]*/i, "");
  s = s.replace(/^part[_\-\.]*/i, "");
  s = s.replace(/\bsegment[_\-\.]*\d*\b/gi, "");

  // drop repeated `_part_*` suffixes or trailing tokens like _0_part_1
  s = s.replace(/_part[_\-\.\d]*$/i, "");
  s = s.replace(/_part[_\-\.\d]+/gi, " ");
  s = s.replace(/_+/g, " ");

  // replace odd punctuation, dots and multiple spaces
  s = s.replace(/[._]+/g, " ");
  s = s.replace(/\s{2,}/g, " ");
  s = s.trim();

  // if it's still an "unnamed" style name, mark it
  if (/^unnamed\b/i.test(s) || s.length === 0) {
    s = "Unnamed road";
  }

  // Capitalize words lightly
  s = s
    .split(" ")
    .map((w) => (w.length > 1 ? w[0].toUpperCase() + w.slice(1) : w.toUpperCase()))
    .join(" ");

  // short form for axis ticks
  if (short && s.length > maxLen) {
    return s.slice(0, maxLen - 1).trim() + "…";
  }

  return s;
}
// ---------- end prettify ----------

function SkeletonCard() {
  return (
    <div className="card skeleton">
      <div className="s-title" />
      <div className="s-row" />
      <div className="s-row short" />
    </div>
  );
}

//co2 logic (unchanged)
async function fetchCO2ForCity(cityName) {
  try {
    const apiKey = "9505fd1df737e20152fbd78cdb289b6a";
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

    const CO_MOLAR_MASS = 28;
    const CO2_MOLAR_MASS = 44;
    const factor = CO2_MOLAR_MASS / CO_MOLAR_MASS;

    const co2FromCo = co * factor;

    return {
      co,
      co2FromCo,
    };
  } catch (err) {
    console.error("Failed to fetch CO/CO2 from OpenWeather", err);
    return null;
  }
}

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

export default function Dashboard() {
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

  const [data, setData] = useState([]); // rows: {segment, name, time, vehicle_count, lat, lon}
  const [predictions, setPredictions] = useState({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [co2Value, setCo2Value] = useState(null);
  const [viewMode, setViewMode] = useState("live"); // "live" | "predictive"



  const computeSeverity = (trafficResp) => {
    const d = trafficResp?.data || {};
    if (d.severity != null) return d.severity;
    const jf = d.jamFactor ?? 0;
    return Math.round(jf * 10 * 10);
  };

  const load = async () => {
    setLoading(true);
    setError("");
    setData([]);
    setPredictions({});
    setCo2Value(null);

    if (typeof window !== "undefined") {
      localStorage.setItem("trafficCity", city);
      localStorage.setItem("trafficSegments", String(segmentsNum));
      localStorage.setItem("trafficTimeSteps", String(timeSteps));
    }

    try {
      const [r, co2] = await Promise.all([getRoads(city, segmentsNum * 3), fetchCO2ForCity(city)]);
      const list = normalizeRoads(r.data.roads || [], segmentsNum);

      const rows = [];
      const preds = {};

      await Promise.all(
        list.map(async (road) => {
          try {
            const coords = road.coordinates || [];
            const mid = coords[Math.floor(coords.length / 2)] || coords[0] || [0, 0];
            const lat = mid[0];
            const lon = mid[1];

            const t = await getLiveTraffic(road.id, lat, lon, city);
            const sev = computeSeverity(t);
            const value = typeof sev === "number" ? sev : Number(sev) || 0;

            preds[road.id] = value;

            // use prettified name here and keep raw id as segment
            rows.push({
              segment: road.id,
              name: prettifyRoadName(road.name || road.id, { short: false }),
              time: "Now",
              vehicle_count: value,
              lat,
              lon,
              rawName: road.name || road.id,
            });
          } catch (e) {
            console.error("live traffic error", e);
            preds[road.id] = 0;
            rows.push({
              segment: road.id,
              name: prettifyRoadName(road.name || road.id, { short: false }),
              time: "Now",
              vehicle_count: 0,
              lat: 0,
              lon: 0,
              rawName: road.name || road.id,
            });
          }
        })
      );

      setData(rows);
      setPredictions(preds);
      setCo2Value(co2);
    } catch (e) {
      console.error(e);
      setError("Failed to fetch road data or live traffic.");
    } finally {
      setLoading(false);
    }
  };
  const loadPredictive = async () => {
    setLoading(true);
    setError("");
    setData([]);
    setPredictions({});

    try {
      const r = await getRoads(city, segmentsNum * 3);
      const list = normalizeRoads(r.data.roads || [], segmentsNum);

      const rows = {};
      const preds = {};

      for (const road of list) {
        const res = await predictToday(road.id, 30, timeSteps,city);
        const d = res.data;

        preds[road.id] = d.predicted_today;

        rows[road.id] = {
          segment: road.id,
          name: prettifyRoadName(road.name || road.id),
          shortName: prettifyRoadName(road.name || road.id, { short: true }),
          avg_7d: d.avg_7d,
          predicted: d.predicted_today,
          rawName: road.name || road.id
        };
      }

      setData(Object.values(rows));
      setPredictions(preds);

    } catch (e) {
      setError("Failed to load predictive traffic");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const summary = useMemo(() => {
    return data.map((d) => {
      // LIVE MODE
      if (typeof d.vehicle_count === "number") {
        return {
          segment: d.segment,
          name: d.name,
          shortName: prettifyRoadName(d.rawName || d.name, { short: true }),
          avg: Number(d.vehicle_count.toFixed(1)),
          predicted: predictions[d.segment] ?? d.vehicle_count,
          history: [
            { time: d.time, count: d.vehicle_count }
          ]
        };
      }

      // PREDICTIVE MODE
      return {
        segment: d.segment,
        name: d.name,
        shortName: prettifyRoadName(d.rawName || d.name, { short: true }),
        avg: Number(d.avg_7d.toFixed(1)),          // 7-day average
        predicted: Number(d.predicted.toFixed(1)), // today
        history: [
          { time: "7d avg", count: d.avg_7d },
          { time: "Today", count: d.predicted }
        ]
      };
    });
  }, [data, predictions]);

  return (
    <div className="dashboard-root">
      <h2>Traffic Dashboard</h2>

      <div className="controls">
        <div className="ctrl-left">
          <label>
            City
            <input value={city} onChange={(e) => setCity(e.target.value)} />
          </label>

          <label>
            Segments
            <input
              type="number"
              min={1}
              max={999}
              value={segmentsNum}
              onChange={(e) => setSegmentsNum(Number(e.target.value))}
            />
          </label>

          <label>
            Time steps
            <input
              type="number"
              min={3}
              max={999}
              value={timeSteps}
              onChange={(e) => setTimeSteps(Number(e.target.value))}
            />
          </label>

          <label>
            View
            <select
              value={viewMode}
              onChange={(e) => setViewMode(e.target.value)}
            >
              <option value="live">Live (Realtime)</option>
              <option value="predictive">Predictive (Today)</option>
            </select>
          </label>


          <button
                className="btn-primary"
                onClick={() => {
                  if (viewMode === "live") load();
                  else loadPredictive();
                }}
                disabled={loading}
              >

            {loading ? "Loading…" : "Update"}
          </button>
        </div>

        <div className="ctrl-right">
          <div className="legend">
            <span className="legend-dot green" /> Low
            <span className="legend-dot orange" /> Medium
            <span className="legend-dot red" /> High
          </div>
        </div>
      </div>

      {error && <div className="error">{error}</div>}

      <div className="summary-chart">
        <h3>Average vehicle count (by segment)</h3>

        <div className="summary-chart-inner">
          {!loading && summary.length > 0 ? (
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={summary}>
                {/* show shortName on ticks and rotate them for readability */}
                <XAxis
                  dataKey="shortName"
                  interval={0}
                  tick={{ fontSize: 12 }}
                  tickFormatter={(v) => v}
                  height={60}
                  angle={-45}
                  textAnchor="end"
                />
                <YAxis />
                <Tooltip
                  // tooltip will show the full cleaned name (value is name)
                  labelFormatter={(idx) => {
                    const item = summary.find((s) => s.shortName === idx);
                    return item ? item.name : idx;
                  }}
                />
                <Bar dataKey="avg" fill="#4f46e5" />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <div style={{ height: 250 }} className="chart-skeleton" />
          )}

          <div className="co2-overlay">
              {co2Value ? (
                <>
                  CO: {co2Value.co.toFixed(0)} μg/m³<br />
                  CO₂ : {co2Value.co2FromCo.toFixed(0)} μg/m³
                </>
              ) : (
                <>Air data: —</>
              )}
          </div>
        </div>
      </div>

      <div className="cards-grid">
        {loading &&
          Array.from({ length: Math.max(3, segmentsNum) }).map((_, i) => (
            <SkeletonCard key={i} />
          ))}

        {!loading &&
          summary.map((s) => {
          const pred =
            typeof s.predicted === "number"
              ? s.predicted
              : s.avg;
            const lvl = levelFor(pred);
            return (
              <div key={s.segment} className={clsx("card")}>
                <div className="card-header">
                  <strong title={s.name}>{s.name}</strong>
                  <span className="card-sub">Avg: {s.avg.toFixed(1)}</span>
                </div>

                <div className="card-body">
                  <div className="predicted">
                    <div className="pred-value">
                      {pred ? Number(pred).toFixed(1) : "-"}
                    </div>
                    <div className="pred-label" style={{ color: lvl.color }}>
                      {lvl.label}
                    </div>
                  </div>

                  <div className="mini-chart">
                    <ResponsiveContainer width="100%" height={60}>
                      <LineChart data={s.history}>
                        <Line
                          type="monotone"
                          dataKey="count"
                          stroke="#0ea5a4"
                          strokeWidth={2}
                          dot={false}
                        />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                </div>

                <div className="card-footer">
                  <button
                    className="btn-small"
                    onClick={() =>
                      navigator.clipboard.writeText(s.segment)
                    }
                  >
                    Copy ID
                  </button>
                </div>
              </div>
            );
          })}
      </div>
    </div>
  );
}
