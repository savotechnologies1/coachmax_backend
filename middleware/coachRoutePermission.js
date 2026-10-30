const { can, isPrivileged } = require("../utils/coachPermissions");

module.exports = (req, res, next) => {
  if (isPrivileged(req.admin) || req.admin?.accessMode === "FULL") return next();
  const path = req.path || "";
  if (path === "/access") return next();
  let module;
  if (path.startsWith("/dashboard") || path.startsWith("/notifications") || path === "/fcm-token") module = "dashboard";
  else if (path.startsWith("/team-attendance")) module = "attendance";
  else if (path.startsWith("/attendance")) module = "attendance";
  else if (path.startsWith("/classes") || path === "/getClasses") module = "classes";
  else if (path.startsWith("/teams")) module = "teams";
  else if (path.startsWith("/unique-players") || path.startsWith("/player/")) module = "players";
  else if (path.startsWith("/temporary-players")) module = req.method === "GET" ? "requests" : "players";
  else if (path.startsWith("/notes")) module = "notes";
  else if (path.startsWith("/chat/")) module = "communication";
  if (!module) return res.status(403).json({ message: "This coach permission is disabled" });
  const action = path.startsWith("/notifications") || path === "/fcm-token" ? "read"
    : req.method === "GET" ? "read" : path.includes("attendance") ? "edit" : req.method === "POST" ? "create" : req.method === "DELETE" ? "delete" : "edit";
  if (!can(req.admin, module, action)) return res.status(403).json({ message: "This coach permission is disabled" });
  return next();
};
