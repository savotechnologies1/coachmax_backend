const mongoose = require("mongoose");
const Admin = require("../models/Admin");
const AuditLog = require("../models/AuditLog");
const { tokenHash, isActiveToken, clientIp, deviceInfo } = require("../utils/sessionInfo");

const targetFor = async (req, res) => {
  if (!req.params.coachId) return Admin.findById(req.admin._id).select("+sessions");
  if (!["SUPER_ADMIN", "ADMIN"].includes(req.admin.role)) {
    res.status(403).json({ message: "Only admins can manage another coach's sessions" });
    return null;
  }
  if (!mongoose.isValidObjectId(req.params.coachId)) {
    res.status(400).json({ message: "Invalid coach ID" });
    return null;
  }
  const coach = await Admin.findOne({ _id: req.params.coachId, role: "COACH" }).select("+sessions");
  if (!coach) res.status(404).json({ message: "Coach not found" });
  return coach;
};

const audit = async (req, target, action, description) => AuditLog.create({
  user: req.admin._id, userRole: req.admin.role, actorName: req.admin.name || "", actorEmail: req.admin.email || "", action, entityType: "Admin",
  entityId: target._id, entityName: target.name || target.email, description, ipAddress: clientIp(req), deviceInfo: deviceInfo(req).userAgent, source: deviceInfo(req).source,
});

exports.listSessions = async (req, res, next) => {
  try {
    const target = await targetFor(req, res);
    if (!target) return;
    const activeTokens = [...new Map((target.tokens || []).filter(isActiveToken).map((token) => [tokenHash(token), token])).values()];
    const expiredTokens = (target.tokens || []).filter((token) => !isActiveToken(token));
    if (expiredTokens.length) await Admin.updateOne({ _id: target._id }, { $pull: {
      tokens: { $in: expiredTokens }, sessions: { tokenHash: { $in: expiredTokens.map(tokenHash) } },
    } });
    const byHash = new Map((target.sessions || []).map((session) => [session.tokenHash, session]));
    const data = activeTokens.map((token) => {
      const hash = tokenHash(token);
      const item = byHash.get(hash);
      return {
        id: item?._id || hash,
        source: item?.source || "Unknown",
        device: item?.device || "Previous session",
        ipAddress: item?.ipAddress || "",
        userAgent: item?.userAgent || "",
        signedInAt: item?.signedInAt || null,
        lastSeenAt: item?.lastSeenAt || null,
        current: String(target._id) === String(req.admin._id) && hash === tokenHash(req.token),
      };
    }).reverse();
    res.json({ success: true, total: data.length, data });
  } catch (error) { next(error); }
};

exports.revokeSession = async (req, res, next) => {
  try {
    const target = await targetFor(req, res);
    if (!target) return;
    const id = req.params.sessionId;
    const session = (target.sessions || []).find((item) => String(item._id) === id);
    const hash = session?.tokenHash || (/^[a-f0-9]{64}$/.test(id) ? id : "");
    const token = (target.tokens || []).find((value) => tokenHash(value) === hash);
    if (!token) return res.status(404).json({ message: "Active session not found" });
    const otherUsesFcm = session?.fcmToken && (target.sessions || []).some((item) => item.tokenHash !== hash && item.fcmToken === session.fcmToken);
    await Admin.updateOne({ _id: target._id }, { $pull: {
      tokens: token, sessions: { tokenHash: hash }, ...(session?.fcmToken && !otherUsesFcm ? { fcmTokens: session.fcmToken } : {}),
    } });
    await audit(req, target, "SESSION_REVOKED", `Signed out ${session?.device || "a previous session"} for ${target.name || target.email}`);
    res.json({ success: true, currentRevoked: String(target._id) === String(req.admin._id) && token === req.token });
  } catch (error) { next(error); }
};

exports.revokeAllSessions = async (req, res, next) => {
  try {
    const target = await targetFor(req, res);
    if (!target) return;
    await Admin.updateOne({ _id: target._id }, { $set: { tokens: [], sessions: [], fcmTokens: [] } });
    await audit(req, target, "ALL_SESSIONS_REVOKED", `Signed out every device for ${target.name || target.email}`);
    res.json({ success: true, currentRevoked: String(target._id) === String(req.admin._id) });
  } catch (error) { next(error); }
};
