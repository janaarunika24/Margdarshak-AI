import axios from "axios";

const BACKEND = import.meta.env.VITE_BACKEND_URL || "https://margdarshak-ai-production.up.railway.app/";
const API_KEY = import.meta.env.VITE_API_KEY || "1a6x1hi1wlUUYkBcUEDuQ5xjdRrqKda6mJXF8Ayf2oc";

console.log("[api] BACKEND=", BACKEND, "API_KEY present=", !!API_KEY);

const API = axios.create({
  baseURL: BACKEND,
  headers: {
    "Content-Type": "application/json"
  },
});

API.interceptors.request.use((config) => {
  if (!config) return config;
  config.headers = config.headers || {};
  // add x-api-key
  config.headers["x-api-key"] = API_KEY;

  // add jwt if present
  const token = localStorage.getItem("md_jwt");
  if (token) config.headers["Authorization"] = `Bearer ${token}`;

  return config;
}, (err) => Promise.reject(err));

export const loginUser = (u, p) =>
  API.post("/api/login", { username: u, password: p });

export const fetchTrafficData = (payload) =>
  API.post("/api/data", payload);

export const predictBatch = (segments) =>
  API.post("/api/predict_batch", { segments });

export const fetchWeather = (city) =>
  API.get(`/api/weather/${encodeURIComponent(city)}`);
// New:
export const getRoads = (city, max_roads = 200) =>
  API.get("/api/roads", { params: { city, max_roads } });

export const getLiveTraffic = (road_id, lat = null, lon = null, city) =>
  API.get("/api/live_traffic", {
    params: {
      road_id,
      city,     // 🔥 THIS WAS MISSING
      lat,
      lon
    }
  });


export const predictToday = (segment_id, interval_min, time_steps,city) =>
  API.post("/api/predict_today", {
    segment_id,
    interval_min,
    time_steps,
  },
  {
      params: { city }   // 🔥 REQUIRED
  }
);
