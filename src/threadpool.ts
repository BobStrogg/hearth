// Imported first by main.ts. libuv reads UV_THREADPOOL_SIZE when the pool is first used, so set it before any async
// fs/crypto/dns call. The default (4) is small enough that a few file reads blocked by a macOS privacy prompt could
// stall DNS, crypto and storage for everything else; the file browser also caps how many calls may be stuck.
if (!process.env.UV_THREADPOOL_SIZE) process.env.UV_THREADPOOL_SIZE = "16";
export {};
