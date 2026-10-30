const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const net = require("net");

const tokenHash = (token) => crypto.createHash("sha256").update(String(token)).digest("hex");
const isActiveToken = (token) => { const payload = jwt.decode(token); return Boolean(payload?.exp && payload.exp * 1000 > Date.now()); };
const clientIp = (req) => {
  const remote = String(req.socket?.remoteAddress || "");
  const forwarded = String(req.headers?.["x-forwarded-for"] || "");
  const realIp = String(req.headers?.["x-real-ip"] || "");
  const trustedLocalProxy = /^(::1|127\.0\.0\.1|::ffff:127\.0\.0\.1)$/.test(remote);
  const ip = trustedLocalProxy && (forwarded || realIp)
    ? (forwarded ? forwarded.split(",").pop().trim() : realIp) : (req.ip || remote);
  const normalized = String(ip).replace(/^::ffff:/, "").trim();
  return net.isIP(normalized) ? normalized : "";
};
const deviceInfo = (req) => {
  const userAgent = String(req.headers?.["user-agent"] || "").slice(0, 500);
  const platform = String(req.headers?.["x-client-platform"] || "").toLowerCase();
  const appAgent = /\b(okhttp|expo|reactnative|react-native|cfnetwork)\b/i.test(userAgent);
  const source = platform === "app" || platform === "mobile-app" || appAgent ? "App"
    : platform === "web" || /\b(chrome|firefox|safari|edge|edg\/|opr\/)\b/i.test(userAgent) ? "Web" : "Unknown";
  const os = /iPhone/i.test(userAgent) ? "iPhone" : /iPad/i.test(userAgent) ? "iPad"
    : /Android/i.test(userAgent) ? "Android" : /Windows/i.test(userAgent) ? "Windows"
    : /Macintosh|Mac OS/i.test(userAgent) ? "Mac" : /Linux/i.test(userAgent) ? "Linux" : "Unknown device";
  const browser = /Edg\//i.test(userAgent) ? "Edge" : /Chrome\//i.test(userAgent) ? "Chrome"
    : /Firefox\//i.test(userAgent) ? "Firefox" : /Safari\//i.test(userAgent) ? "Safari" : "";
  return { source, device: [os, source === "Web" ? browser : source === "App" ? "app" : ""].filter(Boolean).join(" · "), userAgent };
};
module.exports = { tokenHash, isActiveToken, clientIp, deviceInfo };
