const mongoose = require("mongoose");
const Admin = require("../models/Admin");
const AuditLog = require("../models/AuditLog");
const { accessFor, normalizePermissions, isPrivileged } = require("../utils/coachPermissions");

exports.getMyAccess = (req, res) => {
  if (!req.admin) return res.status(403).json({ message: "Staff access required" });
  return res.json({ success: true, role: req.admin.role, isActive: req.admin.isActive !== false, ...accessFor(req.admin) });
};

exports.getCoachAccess = async (req, res) => {
  if (!isPrivileged(req.admin)) return res.status(403).json({ message: "Admin only" });
  if (!mongoose.isValidObjectId(req.params.coachId)) return res.status(400).json({ message: "Invalid coach ID" });
  const coach = await Admin.findOne({ _id: req.params.coachId, role: "COACH" }).select("name email isActive accessMode permissions");
  if (!coach) return res.status(404).json({ message: "Coach not found" });
  return res.json({ success: true, coach: { _id: coach._id, name: coach.name, email: coach.email, isActive: coach.isActive }, ...accessFor(coach) });
};

exports.updateCoachAccess = async (req, res) => {
  if (!isPrivileged(req.admin)) return res.status(403).json({ message: "Admin only" });
  if (!mongoose.isValidObjectId(req.params.coachId)) return res.status(400).json({ message: "Invalid coach ID" });
  const { mode, permissions } = req.body || {};
  if (!["FULL", "PARTIAL"].includes(mode) || !permissions || typeof permissions !== "object" || Array.isArray(permissions)) {
    return res.status(400).json({ message: "Valid access mode and permissions are required" });
  }
  let session;
  try {
    session = await mongoose.startSession();
    let newValue;
    await session.withTransaction(async () => {
      const coach = await Admin.findOne({ _id: req.params.coachId, role: "COACH" }).session(session);
      if (!coach) throw Object.assign(new Error("Coach not found"), { statusCode: 404 });
      const oldValue = accessFor(coach);
      coach.accessMode = mode;
      coach.permissions = normalizePermissions(permissions);
      await coach.save({ session });
      newValue = accessFor(coach);
      await AuditLog.create([{
        user: req.admin._id,
        userRole: req.admin.role,
        actorName: req.admin.name || "",
        actorEmail: req.admin.email || "",
        action: "UPDATE_COACH_ACCESS",
        entityType: "COACH",
        entityId: coach._id,
        entityName: coach.name || coach.email || "Coach",
        source: require("../utils/sessionInfo").deviceInfo(req).source,
        ipAddress: require("../utils/sessionInfo").clientIp(req),
        deviceInfo: req.get("user-agent") || "",
        oldValue,
        newValue,
        description: `Updated access for ${coach.name || coach.email}`,
      }], { session });
    });
    return res.json({ success: true, message: "Coach access updated", ...newValue });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ message: error.statusCode ? error.message : "Could not save coach access" });
  } finally {
    if (session) await session.endSession();
  }
};
