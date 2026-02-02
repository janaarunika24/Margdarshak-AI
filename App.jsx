import { BrowserRouter, Routes, Route } from "react-router-dom";
import { useEffect } from "react";
import Login from "./pages/Login";
import Dashboard from "./pages/Dashboard";
import MapView from "./pages/MapView";
import Navbar from "./components/Navbar";
import EmergencyCorridor from "./pages/EmergencyCorridor";
import AirQuality from "./pages/AirQuality";

export default function App() {
  useEffect(() => {
    // apply a global page background (behind everything)
    const prevBg = document.documentElement.style.background;
    const prevBodyBg = document.body.style.background;

    document.documentElement.style.background = "#000";         // page base
    document.body.style.background = "#00000045";                // subtle tint if you like

    // optional: set text color globally (careful if components control color)
    // document.documentElement.style.color = "#e6eef3";

    return () => {
      // restore original values on unmount (nice for HMR / tests)
      document.documentElement.style.background = prevBg;
      document.body.style.background = prevBodyBg;
    };
  }, []);

  return (
    <BrowserRouter>
      <Navbar />
      <Routes>
        <Route path="/" element={<Login />} />
        <Route path="/dashboard" element={<Dashboard />} />
        <Route path="/map" element={<MapView />} />
        <Route path="/corridor" element={<EmergencyCorridor />} />
        <Route path="/aqi" element={<AirQuality />} />
      </Routes>
    </BrowserRouter>
  );
}
