import WebSocket from "ws";
import fs from "node:fs";

const RADAR = "192.168.0.9";
const LOG_PATH = "C:/Users/TrackMan 4 Sim/tm-dolphin-bridge/ws_capture.jsonl";

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
    headers: {
      "content-type": "application/json",
      Cookie: `session_id=${cookie}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

async function main() {
  const logStream = fs.createWriteStream(LOG_PATH, { flags: "a" });
  const session = await login();
  console.log(`[auth] session_id obtained`);

  // Keep session alive: /api/ValidateSession every 10s (matches admin UI)
  const sessionKeepalive = setInterval(async () => {
    try {
      const r = await rest("POST", "/api/ValidateSession", session);
      if (!r.ok) console.log(`[keepalive] /api/ValidateSession → ${r.status}`);
    } catch (e) { console.error("[keepalive] err", e.message); }
  }, 10_000);

  // Re-arm the radar every 45s (it auto-disarms after some interval)
  const armLoop = setInterval(async () => {
    const r = await rest("POST", "/api/Setup", session, { IsMeasuring: true });
    console.log(`[arm-loop] /api/Setup IsMeasuring=true → ${r.status}`);
  }, 45_000);

  const ws = new WebSocket(`ws://${RADAR}/ws`, {
    headers: { Cookie: `session_id=${session}` },
  });

  ws.on("open", async () => {
    console.log("[ws] open — sending Subscribe");
    ws.send(JSON.stringify({ Type: "Subscribe", Payload: { MessageList: ["ALL"] } }));
    await new Promise((r) => setTimeout(r, 300));
    const r = await rest("POST", "/api/Setup", session, { IsMeasuring: true });
    console.log(`[arm] /api/Setup IsMeasuring=true → ${r.status}`);
  });

  ws.on("message", (data) => {
    const ts = new Date().toISOString();
    const text = data.toString();
    let parsed;
    try { parsed = JSON.parse(text); } catch { parsed = null; }

    if (parsed?.Type === "Ping") {
      ws.send(JSON.stringify({ Type: "Pong", Payload: null }));
      return;
    }

    const t = parsed?.Type ?? "(non-JSON)";
    const sub = parsed?.SubType ? `/${parsed.SubType}` : "";
    // Shot-relevant events get full dump; noisy ones get truncated
    const isShot = t === "Measurement" || (t === "TrackerState" && parsed?.Payload?.TrackerState !== "Idle");
    const preview = isShot ? text : text.slice(0, 180) + (text.length > 180 ? "…" : "");
    console.log(`[ws ${ts}] ${t}${sub} — ${preview}`);
    logStream.write(JSON.stringify({ ts, parsed: parsed ?? text }) + "\n");
  });

  ws.on("error", (err) => console.error("[ws error]", err.message));
  ws.on("close", (code, reason) => {
    clearInterval(sessionKeepalive);
    clearInterval(armLoop);
    console.log(`[ws closed] code=${code} reason=${reason.toString()}`);
    logStream.end();
  });
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
