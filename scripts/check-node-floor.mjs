// CI guard: exit 1 if this Node.js is older than the given floor (e.g. `node scripts/check-node-floor.mjs 22.23.4`).
// The release's single-file binaries embed the Node.js that builds them, so they must never be built on an unpatched one.
const floor = process.argv[2]; if (!floor) { console.error("usage: check-node-floor.mjs <min-version>"); process.exit(2); }
const p = (v) => v.replace(/^v/, "").split(".").map((x) => parseInt(x, 10) || 0);
const [a, b] = [p(process.versions.node), p(floor)];
let below = false; for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) { below = a[i] < b[i]; break; } }
if (below) { console.error(`Node.js ${process.versions.node} is below the security floor ${floor}; refusing to build.`); process.exit(1); }
console.log(`Node.js ${process.versions.node} >= ${floor}: ok`);
