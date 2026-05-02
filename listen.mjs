import WebSocket from "ws";
import fs from "node:fs";

const RADAR = "192.168.0.9";
const LOG_PATH = "C:/Users/TrackMan 4 Sim/tm-dolphin-bridge/shots.jsonl";

const M_TO_YD = 1.09361;
const MS_TO_MPH = 2.23694;

let shotCount = 0;

async function login() {
  const body = new URLSearchParams({ username: "Admin", action: "Force" });
  const res = await fetch(`http://${RADAR}/auth/login`, {
    method: "POST",
    body,
    headers: { "content-type": "application/x-www-form-urlencoded" },
    redirect: "manual",
  });
  const setCookie = res.headers.get("set-cookie") ?? "";
  const m = setCookie.match(/session_id=([^;]+)/);
  if (!m) throw new Error(`no session cookie (status ${res.status})`);
  return m[1];
}

async function rest(method, path, cookie, body) {
  return fetch(`http://${RADAR}${path}`, {
    method,
    headers: { "content-type": "application/json", Cookie: `session_id=${cookie}` },
    body: body ? JSON.stringify(body) : undefined,
  });
}

function fmt(v, digits = 1) {
  return v === undefined || v === null ? "--" : v.toFixed(digits);
}

function side(v, digits = 1) {
  if (v === undefined || v === null) return "--";
  if (v === 0) return fmt(v, digits);
  return `${fmt(Math.abs(v), digits)} ${v > 0 ? "R" : "L"}`;
}

function printShot(p) {
  shotCount += 1;
  const line = "═".repeat(48);
  console.log(`\n${line}`);
  console.log(`  SHOT #${shotCount}    ${p.Time ?? ""}`);
  console.log(line);
  const bs = p.BallSpeed;
  console.log(`  Ball Speed  :  ${fmt(bs, 1)} m/s     (${fmt(bs * MS_TO_MPH, 1)} mph)`);
  console.log(`  Launch Angle:  ${fmt(p.LaunchAngle, 1)}°`);
  console.log(`  Direction   :  ${side(p.LaunchDirection, 2)}°`);
  console.log(`  Spin Rate   :  ${fmt(p.SpinRate, 0)} rpm`);
  console.log(`  Carry       :  ${fmt(p.Carry, 1)} m        (${fmt(p.Carry * M_TO_YD, 1)} yd)`);
  console.log(`  Total       :  ${fmt(p.Total, 1)} m        (${fmt(p.Total * M_TO_YD, 1)} yd)`);
  console.log(`  Carry Side  :  ${side(p.CarrySide, 1)} m`);
  console.log(`  Total Side  :  ${side(p.TotalSide, 1)} m`);
  console.log(`  Max Height  :  ${fmt(p.MaxHeight, 1)} m`);
  console.log(`  Land Angle  :  ${fmt(p.LandingAngle, 1)}°`);
  console.log(`  Hang Time   :  ${fmt(p.HangTime, 2)} s`);
  if (p.ReducedAccuracy?.length) {
    console.log(`  (reduced accuracy: ${p.ReducedAccuracy.join(", ")})`);
  }
  console.log(line);
}

async function main() {
  const shotLog = fs.createWriteStream(LOG_PATH, { flags: "a" });
  const session = await login();
  console.log("[bridge] authenticated as Admin — arming radar…");

  setInterval(async () => {
    try { await rest("POST", "/api/ValidateSession", session); } catch {}
  }, 10_000);

  setInterval(async () => {
    await rest("POST", "/api/Setup", session, { IsMeasuring: true });
  }, 45_000);

  const ws = new WebSocket(`ws://${RADAR}/ws`, {
    headers: { Cookie: `session_id=${session}` },
  });

  ws.on("open", async () => {
    ws.send(JSON.stringify({ Type: "Subscribe", Payload: { MessageList: ["ALL"] } }));
    await new Promise((r) => setTimeout(r, 300));
    await rest("POST", "/api/Setup", session, { IsMeasuring: true });
    console.log("[bridge] subscribed + armed. Waiting for shots — hit when ready.\n");
  });

  ws.on("message", (data) => {
    let parsed;
    try { parsed = JSON.parse(data.toString()); } catch { return; }

    if (parsed.Type === "Ping") {
      ws.send(JSON.stringify({ Type: "Pong", Payload: null }));
      return;
    }

    if (parsed.Type === "TrackerState" && parsed.Payload?.TrackerState) {
      const state = parsed.Payload.TrackerState;
      if (state !== "Idle") process.stdout.write(`  → ${state}\n`);
    }

    if (parsed.Type === "Measurement" && parsed.Payload?.Kind === "Measurement") {
      printShot(parsed.Payload);
      shotLog.write(JSON.stringify(parsed.Payload) + "\n");
    }
  });

  ws.on("error", (err) => console.error("[ws error]", err.message));
  ws.on("close", (code) => console.log(`[ws closed] code=${code}`));
}

main().catch((err) => { console.error("fatal:", err); process.exit(1); });
