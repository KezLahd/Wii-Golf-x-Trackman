// inject.mjs — fire a synthetic shot at bridge-test.mjs.
//
// Usage:
//   node inject.mjs <BallSpeed> [LaunchAngle] [LaunchDirection]
// Examples:
//   node inject.mjs 50            BallSpeed=50, angle=12 (default), dir=0
//   node inject.mjs 50 14 -10     50 m/s, 14° launch, 10° left
//   node inject.mjs 50 14 +10     50 m/s, 14° launch, 10° right
//
// Sweep helpers:
//   node inject.mjs sweep-dir 50  Fires 50 m/s at -15, -10, -5, 0, +5, +10, +15
//                                 deg with 6s gaps so each shot lands first.
//   node inject.mjs sweep-power   Fires 10, 20, 30, 40, 50, 60, 70 m/s
//                                 at dir=0, with 6s gaps.

const URL = "http://127.0.0.1:8088/inject";

async function fire(BallSpeed, LaunchAngle, LaunchDirection) {
  const body = JSON.stringify({ BallSpeed, LaunchAngle, LaunchDirection });
  const res = await fetch(URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
  const data = await res.json();
  console.log(`→ ${BallSpeed.toFixed(1)} m/s  ${LaunchAngle.toFixed(1)}°  dir=${LaunchDirection.toFixed(1)}°  ${res.status} ${JSON.stringify(data)}`);
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function sweepDir(speed) {
  const dirs = [-15, -10, -5, 0, 5, 10, 15];
  for (const d of dirs) {
    await fire(speed, 12, d);
    await sleep(6000);
  }
}

async function sweepPower() {
  const speeds = [10, 20, 30, 40, 50, 60, 70];
  for (const s of speeds) {
    await fire(s, 12, 0);
    await sleep(6000);
  }
}

const args = process.argv.slice(2);
if (args[0] === "sweep-dir") {
  const speed = parseFloat(args[1] ?? "50");
  await sweepDir(speed);
} else if (args[0] === "sweep-power") {
  await sweepPower();
} else {
  const BallSpeed       = parseFloat(args[0] ?? "50");
  const LaunchAngle     = parseFloat(args[1] ?? "12");
  const LaunchDirection = parseFloat(args[2] ?? "0");
  if (isNaN(BallSpeed)) {
    console.error("usage: node inject.mjs <BallSpeed> [LaunchAngle] [LaunchDirection]");
    process.exit(1);
  }
  await fire(BallSpeed, LaunchAngle, LaunchDirection);
}
