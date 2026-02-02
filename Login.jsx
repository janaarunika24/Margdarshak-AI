import { useState } from "react";
import { loginUser } from "../api";
import { useNavigate } from "react-router-dom";

export default function Login() {
  const n = useNavigate();
  const [u, setU] = useState("");
  const [p, setP] = useState("");
  const [err, setErr] = useState("");

  const go = async () => {
    try {
      const r = await loginUser(u, p);
      localStorage.setItem("md_jwt", r.data.access_token);
      n("/dashboard");
    } catch {
      setErr("Wrong username or password");
    }
  };

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        justifyContent: "center",
        alignItems: "center",
        padding: "28px",
        position: "relative",
        overflow: "hidden",
        // 🔹 SAME BACKGROUND UNIVERSE AS DASHBOARD / AQI / MAP
        background:
          "radial-gradient(circle at top, #020617 0, #020617 40%, #000000 100%)",
        fontFamily: "Inter, system-ui, sans-serif",
        color: "#e5e7eb",
      }}
    >
      {/* ================= Traffic / Intersection Layers ================ */}

      {/* CITY GRID – subtle, keeps the tech vibe */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          background: `
             repeating-linear-gradient(0deg, rgba(148,163,184,0.06) 0px, rgba(148,163,184,0.06) 2px, transparent 2px, transparent 110px),
             repeating-linear-gradient(90deg, rgba(148,163,184,0.06) 0px, rgba(148,163,184,0.06) 2px, transparent 2px, transparent 110px)
          `,
          opacity: 0.07,
          animation: "cityGrid 20s linear infinite",
          pointerEvents: "none",
          zIndex: 0,
        }}
      />

      {/* INTERSECTION SPIN – soft blue aura */}
      <div
        style={{
          position: "absolute",
          top: "50%",
          left: "50%",
          width: "380px",
          height: "380px",
          transform: "translate(-50%, -50%)",
          borderRadius: "50%",
          background:
            "radial-gradient(circle, rgba(56,189,248,0.16), transparent 70%)",
          animation: "intersectionSpin 13s linear infinite",
          pointerEvents: "none",
          filter: "blur(10px)",
          opacity: 0.32,
          zIndex: 1,
        }}
      />

      {/* CONGESTION GLOW – green/teal, consistent with AQI vibes */}
      <div
        style={{
          position: "absolute",
          bottom: 0,
          width: "100%",
          height: "260px",
          background:
            "radial-gradient(circle at center, rgba(34,197,94,0.38), transparent 70%)",
          animation: "congestionGlow 5s ease-in-out infinite",
          filter: "blur(22px)",
          pointerEvents: "none",
          opacity: 0.65,
          zIndex: 1,
        }}
      />

      {/* CARS – neon streaks */}
      <div
        style={{
          position: "absolute",
          bottom: "140px",
          left: "-140px",
          width: "68px",
          height: "14px",
          background: "linear-gradient(90deg,#3b82f6,#22d3ee)",
          borderRadius: "999px",
          boxShadow: "0 6px 20px rgba(56,189,248,0.35)",
          animation: "carOne 6s linear infinite",
          zIndex: 2,
        }}
      />

      <div
        style={{
          position: "absolute",
          bottom: "180px",
          left: "-180px",
          width: "62px",
          height: "14px",
          background: "linear-gradient(90deg,#f97316,#fde68a)",
          borderRadius: "999px",
          boxShadow: "0 6px 20px rgba(249,115,22,0.32)",
          animation: "carTwo 6s linear infinite",
          zIndex: 2,
        }}
      />

      <div
        style={{
          position: "absolute",
          bottom: "220px",
          left: "-120px",
          width: "54px",
          height: "14px",
          background: "linear-gradient(90deg,#bbf7d0,#22c55e)",
          borderRadius: "999px",
          boxShadow: "0 6px 20px rgba(34,197,94,0.32)",
          animation: "carThree 6s linear infinite",
          zIndex: 2,
        }}
      />

      {/* LANE LINES */}
      <div
        style={{
          position: "absolute",
          bottom: "120px",
          width: "100%",
          height: "3px",
          background:
            "repeating-linear-gradient(90deg, rgba(255,255,255,0.55) 0 28px, transparent 28px 56px)",
          animation: "laneFlowLogin 3s linear infinite",
          opacity: 0.42,
          zIndex: 1,
        }}
      />

      <div
        style={{
          position: "absolute",
          bottom: "160px",
          width: "100%",
          height: "3px",
          background:
            "repeating-linear-gradient(90deg, rgba(255,255,255,0.4) 0 28px, transparent 28px 56px)",
          animation: "laneFlowLogin 2s linear infinite",
          opacity: 0.34,
          zIndex: 1,
        }}
      />

      {/* TRAFFIC LIGHT – small UI jewel */}
      <div
        style={{
          position: "absolute",
          top: "22px",
          right: "22px",
          width: "28px",
          height: "88px",
          background: "#020617",
          borderRadius: "14px",
          padding: "6px",
          display: "flex",
          flexDirection: "column",
          gap: "8px",
          justifyContent: "center",
          alignItems: "center",
          boxShadow: "0 0 18px rgba(15,23,42,0.9)",
          border: "1px solid rgba(30,64,175,0.6)",
          zIndex: 3,
        }}
      >
        <div
          style={{
            width: "16px",
            height: "16px",
            borderRadius: "50%",
            animation: "redCycle 6s infinite",
          }}
        />
        <div
          style={{
            width: "16px",
            height: "16px",
            borderRadius: "50%",
            animation: "yellowCycle 6s infinite",
          }}
        />
        <div
          style={{
            width: "16px",
            height: "16px",
            borderRadius: "50%",
            animation: "greenCycle 6s infinite",
          }}
        />
      </div>

      {/* ========================= LOGIN BOX ========================= */}
      <div
        style={{
          width: "min(92%, 380px)",
          padding: "44px 36px",
          boxSizing: "border-box",
          borderRadius: "20px",
          background:
            "linear-gradient(180deg, rgba(15,23,42,0.96), rgba(15,23,42,0.86))",
          backdropFilter: "blur(20px)",
          boxShadow:
            "0 18px 55px rgba(15,23,42,0.9), 0 0 40px rgba(56,189,248,0.25)",
          color: "white",
          textAlign: "center",
          position: "relative",
          zIndex: 10,
          display: "flex",
          flexDirection: "column",
          gap: "20px",
          alignItems: "stretch",
          border: "1px solid rgba(148,163,184,0.5)",
        }}
      >
        <h2
          style={{
            margin: 0,
            fontSize: "30px",
            color: "#dbeafe",
            fontWeight: 700,
            textShadow: "0 0 16px rgba(59,130,246,0.9)",
            paddingBottom: "14px",
            textAlign: "center",
            letterSpacing: "0.08em",
            textTransform: "uppercase",
          }}
        >
          Login
        </h2>

        {/* INPUTS */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "14px",
            width: "100%",
            boxSizing: "border-box",
          }}
        >
          <input
            placeholder="Username"
            onChange={(e) => setU(e.target.value)}
            style={{
              width: "100%",
              boxSizing: "border-box",
              padding: "14px 16px",
              borderRadius: "12px",
              background: "rgba(15,23,42,0.92)",
              color: "white",
              fontSize: "15px",
              border: "1px solid rgba(148,163,184,0.55)",
              outline: "none",
              boxShadow: "0 0 0 1px rgba(15,23,42,0.9)",
            }}
          />

          <input
            type="password"
            placeholder="Password"
            onChange={(e) => setP(e.target.value)}
            style={{
              width: "100%",
              boxSizing: "border-box",
              padding: "14px 16px",
              borderRadius: "12px",
              background: "rgba(15,23,42,0.92)",
              color: "white",
              fontSize: "15px",
              border: "1px solid rgba(148,163,184,0.55)",
              outline: "none",
              boxShadow: "0 0 0 1px rgba(15,23,42,0.9)",
            }}
          />
        </div>

        {/* BUTTON + ERROR */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "10px",
            width: "100%",
            boxSizing: "border-box",
          }}
        >
          <button
            onClick={go}
            style={{
              width: "100%",
              padding: "14px 16px",
              borderRadius: "999px",
              background: "linear-gradient(135deg, #2563eb, #38bdf8)",
              color: "white",
              fontSize: "16px",
              border: "none",
              cursor: "pointer",
              boxShadow:
                "0 14px 34px rgba(37,99,235,0.65), 0 0 20px rgba(56,189,248,0.4)",
              fontWeight: 700,
              letterSpacing: "0.05em",
              textTransform: "uppercase",
            }}
          >
            Login
          </button>

          {err && (
            <p
              style={{
                color: "#fca5a5",
                margin: 0,
                fontSize: "14px",
                textAlign: "center",
              }}
            >
              {err}
            </p>
          )}
        </div>
      </div>

      {/* ======================== KEYFRAMES ======================== */}
      <style>
        {`
          @keyframes cityGrid {
            0% { transform: translate(0,0); }
            100% { transform: translate(-80px,-80px); }
          }

          @keyframes intersectionSpin {
            from { transform: translate(-50%,-50%) rotate(0deg); }
            to { transform: translate(-50%,-50%) rotate(360deg); }
          }

          @keyframes congestionGlow {
            0%,100% { opacity: 0.3; }
            50% { opacity: 0.9; }
          }

          @keyframes carOne {
            0% { left:-140px; transform: scale(1); }
            33%{ left:-140px; }
            55%{ left:25%; transform: scale(1.03); }
            100%{ left:110%; transform: scale(1.08); }
          }

          @keyframes carTwo {
            0% { left:-180px; transform: scale(1); }
            33%{ left:-180px; }
            55%{ left:15%; transform: scale(1.02); }
            100%{ left:110%; transform: scale(1.06); }
          }

          @keyframes carThree {
            0% { left:-120px; transform: scale(1); }
            33%{ left:-120px; }
            55%{ left:35%; transform: scale(1.04); }
            100%{ left:110%; transform: scale(1.09); }
          }

          @keyframes laneFlowLogin {
            0% { background-position-x:0; }
            100% { background-position-x:240px; }
          }

          @keyframes redCycle {
            0%,33% { background:#ef4444; box-shadow:0 0 10px #ef4444; }
            34%,100% { background:#450a0a; box-shadow:none; }
          }

          @keyframes yellowCycle {
            0%,33% { background:#451a03; box-shadow:none; }
            34%,66% { background:#eab308; box-shadow:0 0 10px #eab308; }
            67%,100%{ background:#451a03; box-shadow:none; }
          }

          @keyframes greenCycle {
            0%,66% { background:#064e3b; box-shadow:none; }
            67%,100%{ background:#22c55e; box-shadow:0 0 10px #22c55e; }
          }
        `}
      </style>
    </div>
  );
}
