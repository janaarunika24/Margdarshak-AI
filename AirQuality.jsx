// src/pages/AirQuality.jsx
import React, { useState, useEffect, useMemo } from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";
import clsx from "clsx";
import "./AirQuality.css";

/**
 * Resolve user location text to lat/lon using Open-Meteo geocoding API.
 */
async function geocodeCity(name) {
  const res = await fetch(
    `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(
      name
    )}&count=1&language=en&format=json`
  );

  if (!res.ok) throw new Error("Failed to geocode city");

  const data = await res.json();
  if (!data.results || data.results.length === 0) {
    throw new Error("Location not found");
  }

  const { latitude, longitude, name: resolvedName, country } = data.results[0];

  const renameMap = {
    "Calcutta": "Kolkata",
    "Bombay": "Mumbai",
    "Bangalore": "Bengaluru",
    "Madras": "Chennai"
  };

  const fixedName = renameMap[resolvedName] || resolvedName;

  return {
    lat: latitude,
    lon: longitude,
    label: country ? `${fixedName}, ${country}` : fixedName,
  };
}

/**
 * Fetch air-quality data from Open-Meteo.
 */
async function fetchAirQuality(lat, lon) {
  const params = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lon),
    current:
      "us_aqi,carbon_monoxide,nitrogen_dioxide,sulphur_dioxide,ozone,pm10,pm2_5,uv_index,ammonia,dust",
    hourly: "pm2_5,pm10,ozone,uv_index",
    forecast_days: "1",
    timezone: "auto",
  });

  const res = await fetch(
    `https://air-quality-api.open-meteo.com/v1/air-quality?${params.toString()}`
  );
  if (!res.ok) throw new Error("Failed to fetch air quality");
  return res.json();
}

/**
 * Color for AQI levels (US AQI scale).
 */
function aqiLevel(aqi) {
  if (aqi == null) return { label: "Unknown", color: "#9ca3af" };
  if (aqi <= 50) return { label: "Good", color: "#22c55e" };
  if (aqi <= 100) return { label: "Moderate", color: "#eab308" };
  if (aqi <= 150) return { label: "Unhealthy (SG)", color: "#f97316" };
  if (aqi <= 200) return { label: "Unhealthy", color: "#ef4444" };
  if (aqi <= 300) return { label: "Very Unhealthy", color: "#a855f7" };
  return { label: "Hazardous", color: "#7f1d1d" };
}

export default function AirQuality() {
  const [query, setQuery] = useState("Kolkata");
  const [location, setLocation] = useState({
    label: "Kolkata, India",
    lat: 22.5626,
    lon: 88.3630,
  });

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [aqData, setAqData] = useState(null);

  const load = async (fromButton = false) => {
    try {
      setLoading(true);
      setError("");

      let loc = location;

      // If user typed something new and clicked search, re-geocode
      if (fromButton || !aqData) {
        loc = await geocodeCity(query.trim() || "Kolkata");
        setLocation(loc);
      }

      const data = await fetchAirQuality(loc.lat, loc.lon);
      setAqData(data);
    } catch (e) {
      console.error(e);
      setError(e.message || "Failed to load air quality");
    } finally {
      setLoading(false);
    }
  };

  // Initial load
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const current = aqData?.current;
  const aqi = current?.us_aqi ?? null;
  const lvl = aqiLevel(aqi);

  const hourlyChartData = useMemo(() => {
    const hourly = aqData?.hourly;
    if (!hourly?.time) return [];

    const times = hourly.time;
    const pm25 = hourly.pm2_5 || [];
    const pm10 = hourly.pm10 || [];
    const ozone = hourly.ozone || [];
    const uv = hourly.uv_index || [];

    return times.map((t, i) => {
      const label = t.slice(11, 16); // HH:MM
      return {
        time: label,
        pm25: pm25[i] ?? null,
        pm10: pm10[i] ?? null,
        ozone: ozone[i] ?? null,
        uv: uv[i] ?? null,
      };
    });
  }, [aqData]);

  const pollutantCards = [
    {
      key: "carbon_monoxide",
      label: "CO",
      unit: "μg/m³",
    },
    {
      key: "nitrogen_dioxide",
      label: "NO₂",
      unit: "μg/m³",
    },
    {
      key: "sulphur_dioxide",
      label: "SO₂",
      unit: "μg/m³",
    },
    {
      key: "ozone",
      label: "O₃",
      unit: "μg/m³",
    },
    {
      key: "pm2_5",
      label: "PM2.5",
      unit: "μg/m³",
    },
    {
      key: "pm10",
      label: "PM10",
      unit: "μg/m³",
    },
    {
      key: "ammonia",
      label: "NH₃",
      unit: "μg/m³",
    },
    {
      key: "dust",
      label: "Dust",
      unit: "μg/m³",
    },
    {
      key: "uv_index",
      label: "UV Index",
      unit: "",
    },
  ];

  return (
    <div className="aqi-root">
      <div className="aqi-shell">
        {/* Top bar */}
        <header className="aqi-header">
          <div>
            <h1 className="aqi-title">Air Quality Monitor</h1>
            <p className="aqi-subtitle">
              Hyper-minimal dark mode view of real-time air quality.
            </p>
          </div>

          <div className="aqi-search">
            <input
              className="aqi-input"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search city or place…"
            />
            <button
              className="aqi-btn"
              onClick={() => load(true)}
              disabled={loading}
            >
              {loading ? "Loading…" : "Update"}
            </button>
          </div>
        </header>

        {/* Location + AQI hero section */}
        <section className="aqi-hero">
          <div className="aqi-location">
            <span className="aqi-location-label">Location</span>
            <h2 className="aqi-location-name">{location.label}</h2>
            <div className="aqi-location-meta">
              <span>
                Lat: {location.lat.toFixed(3)} | Lon: {location.lon.toFixed(3)}
              </span>
              {aqData?.current?.time && (
                <span>
                  Last update:{" "}
                  {new Date(aqData.current.time).toLocaleString()}
                </span>
              )}
            </div>
          </div>

          <div className="aqi-main-card">
            <div className="aqi-main-ring">
              <div className="aqi-main-inner">
                <span className="aqi-main-label">US AQI</span>
                <span
                  className="aqi-main-value"
                  style={{ color: lvl.color }}
                >
                  {aqi != null ? aqi.toFixed(0) : "—"}
                </span>
                <span className="aqi-main-level">{lvl.label}</span>
              </div>
            </div>
            <div className="aqi-main-note">
              Lower is better. Values &amp; categories based on US AQI scale.
            </div>
          </div>
        </section>

        {error && <div className="aqi-error">{error}</div>}

        {/* Pollutant cards */}
        <section className="aqi-grid">
          {pollutantCards.map((p) => {
            const val = current?.[p.key];
            return (
              <div key={p.key} className="aqi-card">
                <div className="aqi-card-top">
                  <span className="aqi-pill">{p.label}</span>
                  <span className="aqi-unit">{p.unit}</span>
                </div>
                <div className="aqi-card-value">
                  {val != null ? val.toFixed(1) : "—"}
                </div>
              </div>
            );
          })}
        </section>

        {/* Charts */}
        <section className="aqi-charts">
          <div className="aqi-chart-card">
            <div className="aqi-chart-header">
              <span>PM2.5 &amp; PM10 (next 24 hours)</span>
              <span className="aqi-chart-caption">
                Particulate matter · smaller = deeper lung penetration
              </span>
            </div>
            <div className="aqi-chart-body">
              {hourlyChartData.length ? (
                <ResponsiveContainer width="100%" height={220}>
                  <LineChart data={hourlyChartData}>
                    <XAxis dataKey="time" hide />
                    <YAxis />
                    <Tooltip />
                    <Legend />
                    <Line
                      type="monotone"
                      dataKey="pm25"
                      name="PM2.5"
                      stroke="#22c55e"
                      dot={false}
                      strokeWidth={2}
                    />
                    <Line
                      type="monotone"
                      dataKey="pm10"
                      name="PM10"
                      stroke="#38bdf8"
                      dot={false}
                      strokeWidth={2}
                    />
                  </LineChart>
                </ResponsiveContainer>
              ) : (
                <div className="aqi-chart-skeleton" />
              )}
            </div>
          </div>

          <div className="aqi-chart-card">
            <div className="aqi-chart-header">
              <span>Ozone &amp; UV Index</span>
              <span className="aqi-chart-caption">
                Photochemical smog &amp; UV exposure over the day
              </span>
            </div>
            <div className="aqi-chart-body">
              {hourlyChartData.length ? (
                <ResponsiveContainer width="100%" height={220}>
                  <LineChart data={hourlyChartData}>
                    <XAxis dataKey="time" hide />
                    <YAxis />
                    <Tooltip />
                    <Legend />
                    <Line
                      type="monotone"
                      dataKey="ozone"
                      name="O₃"
                      stroke="#a855f7"
                      dot={false}
                      strokeWidth={2}
                    />
                    <Line
                      type="monotone"
                      dataKey="uv"
                      name="UV Index"
                      stroke="#f97316"
                      dot={false}
                      strokeWidth={2}
                    />
                  </LineChart>
                </ResponsiveContainer>
              ) : (
                <div className="aqi-chart-skeleton" />
              )}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
