// rest-pose.mjs — set bridge-test.mjs's resting accel pose to a fixed
// vector so we can find what orientation WS Golf reads as "address."
//
// Usage:
//   node rest-pose.mjs <ax> <ay> <az>
// Examples:
//   node rest-pose.mjs 0 1 0       (current neutral — Mii at "180° wrong")
//   node rest-pose.mjs 0 -1 0      flip Y
//   node rest-pose.mjs 0 0 1       Z up
//   node rest-pose.mjs 0 0 -1      Z down
//   node rest-pose.mjs 1 0 0       X right
//   node rest-pose.mjs reset       restore the default (0, 1, 0)

const URL = "http://127.0.0.1:8088/rest-pose";

const args = process.argv.slice(2);
let body;
if (args[0] === "reset") {
  body = JSON.stringify({ reset: true });
} else if (args.length === 3) {
  const [x, y, z] = args.map(parseFloat);
  if ([x, y, z].some(isNaN)) {
    console.error("usage: node rest-pose.mjs <ax> <ay> <az>  |  node rest-pose.mjs reset");
    process.exit(1);
  }
  body = JSON.stringify({ x, y, z });
} else {
  console.error("usage: node rest-pose.mjs <ax> <ay> <az>  |  node rest-pose.mjs reset");
  process.exit(1);
}

const res = await fetch(URL, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body,
});
const data = await res.json();
console.log(`${res.status} ${JSON.stringify(data)}`);
