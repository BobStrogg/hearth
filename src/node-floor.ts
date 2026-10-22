// Minimum patched Node.js release per supported line. Bump these after a Node.js security release
// (last: October 2026, CVE-2026-111497 Brotli decoder RCE and others).
export const NODE_MIN_MAJOR = 22;
export const NODE_FLOORS: Readonly<Record<number, string>> = { 22: "22.23.4", 24: "24.22.1", 26: "26.12.1" };

export interface NodeFloorResult { level: "ok" | "warn" | "fail"; message?: string }

const parts = (v: string) => v.replace(/^v/, "").split(".").map((x) => parseInt(x, 10) || 0);
const lt = (a: string, b: string) => { const x = parts(a), y = parts(b); for (let i = 0; i < 3; i++) { if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) < (y[i] ?? 0); } return false; };

/** Is this Node.js version supported and patched? (Lines newer than the newest listed one are assumed fine.) */
export function nodeFloorCheck(version: string = process.versions.node): NodeFloorResult {
  const v = version.replace(/^v/, ""); const major = parts(v)[0];
  const listed = Object.keys(NODE_FLOORS).map(Number); const top = Math.max(...listed);
  const lines = listed.map((m) => NODE_FLOORS[m]).join(", ");
  if (major < NODE_MIN_MAJOR) return { level: "fail", message: `Node.js ${v} is no longer supported and gets no security fixes. Install Node.js ${NODE_FLOORS[NODE_MIN_MAJOR]} or newer (patched releases: ${lines}).` };
  const floor = NODE_FLOORS[major];
  if (floor) return lt(v, floor) ? { level: "warn", message: `Node.js ${v} has known security vulnerabilities. Update to ${floor} or newer.` } : { level: "ok" };
  if (major > top) return { level: "ok" };
  return { level: "warn", message: `Node.js ${major}.x no longer gets security fixes. Use a supported line (patched releases: ${lines}).` };
}
