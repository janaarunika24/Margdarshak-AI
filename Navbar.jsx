import { Link } from "react-router-dom";

export default function Navbar() {

  // Ripple animation (logic untouched)
  const ripple = (e) => {
    const btn = e.target;
    const circle = document.createElement("span");
    const size = 60;
    circle.style.width = circle.style.height = `${size}px`;
    circle.style.position = "absolute";
    circle.style.borderRadius = "50%";
    circle.style.background = "rgba(255,255,255,0.5)";
    circle.style.left = `${e.clientX - btn.getBoundingClientRect().left - size / 2}px`;
    circle.style.top = `${e.clientY - btn.getBoundingClientRect().top - size / 2}px`;
    circle.style.transform = "scale(0)";
    circle.style.animation = "rippleNav 0.6s linear";
    circle.style.pointerEvents = "none";
    btn.appendChild(circle);
    setTimeout(() => circle.remove(), 600);
  };

  const paths = ["/", "/dashboard", "/map", "/corridor", "/aqi"];
  const labels = ["Login", "Dashboard", "Map", "EmergencyCorridor", "AQI"];

  return (
    <nav
      style={{
        padding: "16px 28px",
        background: "linear-gradient(135deg, #2a2a2a, #1a1a1a)",
        display: "flex",
        gap: "20px",
        alignItems: "center",
        justifyContent: "flex-start",
        position: "sticky",
        top: 0,
        zIndex: 300,
        border: "none",
        overflow: "hidden",
        backdropFilter: "blur(18px)",
        boxShadow: "0 10px 25px rgba(0,0,0,0.45)"
      }}
    >
      <div
        style={{
          position: "absolute",
          inset: 0,
          background: "rgba(0,0,0,0.1)",
          zIndex: -1
        }}
      />

      {paths.map((path, i) => (
        <Link
          key={i}
          to={path}
          onClick={ripple}
          style={{
            position: "relative",
            textDecoration: "none",
            color: "#d0d0d0",
            fontSize: "18px",
            fontWeight: 600,
            padding: "10px 18px",
            background: "rgba(255,255,255,0.10)",
            borderRadius: "50px",
            transition: "0.35s",
            overflow: "hidden",
            backdropFilter: "blur(6px)"
          }}
          onMouseEnter={(e) => {
            e.target.style.color = "#ffffff";
            e.target.style.boxShadow = "0 0 14px rgba(255,255,255,0.6)";
            const underline = document.createElement("div");
            underline.className = "underline";
            underline.style.position = "absolute";
            underline.style.left = "20%";
            underline.style.bottom = "6px";
            underline.style.height = "3px";
            underline.style.borderRadius = "3px";
            underline.style.background = "rgba(255,255,255,1)";
            underline.style.animation = "underlineGlowNav 0.35s forwards";
            e.target.appendChild(underline);
          }}
          onMouseLeave={(e) => {
            e.target.style.color = "#d0d0d0";
            e.target.style.boxShadow = "none";
            const underline = e.target.querySelector(".underline");
            if (underline) underline.remove();
          }}
        >
          {labels[i]}
        </Link>
      ))}
    </nav>
  );
}
