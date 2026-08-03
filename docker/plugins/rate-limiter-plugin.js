import { createRateLimiterPlugin } from "@contextio/proxy";

const maxRequests = process.env.RATE_LIMITER_MAX_REQUESTS ? parseInt(process.env.RATE_LIMITER_MAX_REQUESTS, 10) : 60;
const windowMs = process.env.RATE_LIMITER_WINDOW_MS ? parseInt(process.env.RATE_LIMITER_WINDOW_MS, 10) : 60000;
const bufferCapacity = process.env.RATE_LIMITER_BUFFER_CAPACITY ? parseInt(process.env.RATE_LIMITER_BUFFER_CAPACITY, 10) : 10;
const enabled = process.env.RATE_LIMITER_ENABLED !== "false";

console.log("Rate limiter plugin: maxRequests =", maxRequests);
console.log("Rate limiter plugin: windowMs =", windowMs);
console.log("Rate limiter plugin: bufferCapacity =", bufferCapacity);
console.log("Rate limiter plugin: enabled =", enabled);

export default () => createRateLimiterPlugin({ defaults: { maxRequests, windowMs, bufferCapacity }, enabled });