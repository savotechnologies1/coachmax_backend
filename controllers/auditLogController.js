const mongoose = require("mongoose");
const AuditLog = require("../models/AuditLog");
const Admin = require("../models/Admin");
const { deviceInfo } = require("../utils/sessionInfo");

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const nameOf = (doc) => doc.fullName || [doc.firstName, doc.lastName].filter(Boolean).join(" ") || doc.teamName || doc.name || doc.title || doc.invoiceNumber || "";
const modelNames = ["User", "Class", "Team", "League", "Program", "Term", "Event", "Product", "Admin", "Invoice", "News"];
const idString = (value) => String(value?._id || value || "");
const scrub = (value, depth = 0) => {
  if (depth > 6 || value == null) return value;
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => scrub(item, depth + 1));
  if (typeof value === "object" && !(value instanceof Date) && !(value instanceof mongoose.Types.ObjectId)) {
    return Object.fromEntries(Object.entries(value).filter(([key]) => !/password|token|secret|otp|authorization/i.test(key))
      .map(([key, item]) => [key, scrub(item, depth + 1)]));
  }
  return value;
};

const addIds = (value, ids, depth = 0) => {
  if (ids.size >= 400 || depth > 4 || value == null) return;
  if (value instanceof mongoose.Types.ObjectId) { ids.add(String(value)); return; }
  if (typeof value === "string" && mongoose.isValidObjectId(value)) ids.add(value);
  else if (Array.isArray(value)) value.slice(0, 50).forEach((item) => addIds(item, ids, depth + 1));
  else if (typeof value === "object") Object.entries(value).slice(0, 50).forEach(([key, item]) => {
    if (!/password|token|secret/i.test(key)) addIds(item, ids, depth + 1);
  });
};

const resolveNames = async (logs) => {
  const ids = new Set();
  logs.forEach((log) => {
    addIds(idString(log.entityId), ids);
    addIds(log.oldValue, ids);
    addIds(log.newValue, ids);
  });
  const values = [...ids];
  const names = {};
  if (!values.length) return names;
  await Promise.all(modelNames.map(async (modelName) => {
    const Model = require(`../models/${modelName}`);
    const docs = await Model.find({ _id: { $in: values } }).select("fullName firstName lastName teamName name title invoiceNumber year").lean();
    docs.forEach((doc) => {
      const label = nameOf(doc);
      if (label) names[idString(doc._id)] = label;
    });
  }));
  const Attendance = require("../models/Attendance");
  const RegistrationRequest = require("../models/RegistrationRequest");
  const [attendance, requests] = await Promise.all([
    Attendance.find({ _id: { $in: values } }).select("class sessionDate").populate("class", "name").lean(),
    RegistrationRequest.find({ _id: { $in: values } }).select("player").populate("player", "fullName firstName lastName").lean(),
  ]);
  attendance.forEach((doc) => { names[idString(doc._id)] = `${doc.class?.name || "Attendance"}${doc.sessionDate ? ` · ${new Date(doc.sessionDate).toISOString().slice(0, 10)}` : ""}`; });
  requests.forEach((doc) => { const name = doc.player && nameOf(doc.player); if (name) names[idString(doc._id)] = `Request for ${name}`; });
  return names;
};

const enrich = async (logs) => {
  const names = await resolveNames(logs);
  return { names, data: logs.map((log) => ({ ...log, oldValue: scrub(log.oldValue), newValue: scrub(log.newValue),
    entityName: log.entityName || names[idString(log.entityId)] || (log.entityType === "RegistrationRequest" && names[idString(log.newValue?.player)] ? `Request for ${names[idString(log.newValue.player)]}` : ""),
    source: log.source || deviceInfo({ headers: { "user-agent": log.deviceInfo || "" } }).source })) };
};

exports.getAuditLogs = async (req, res, next) => {
  try {
    const page = Math.max(1, Math.min(100000, Number.parseInt(req.query.page, 10) || 1));
    const limit = Math.max(10, Math.min(100, Number.parseInt(req.query.limit, 10) || 50));
    const query = {};
    const { action, entityType, userId, userRole, source, startDate, endDate, startAt, endAt } = req.query;
    if (action) query.action = String(action).slice(0, 80);
    if (entityType) query.entityType = String(entityType).slice(0, 80);
    if (userId && mongoose.isValidObjectId(userId)) query.$and = [{ $or: [{ user: userId }, { entityType: "Authentication", entityId: userId }] }];
    if (userRole) query.userRole = String(userRole).slice(0, 30);
    if (source === "Web") (query.$and ||= []).push({ $or: [{ source: "Web" }, { source: { $in: ["", null] }, deviceInfo: /Chrome|Firefox|Safari|Edg\//i }] });
    if (source === "App") (query.$and ||= []).push({ $or: [{ source: "App" }, { source: { $in: ["", null] }, deviceInfo: /okhttp|CFNetwork|Expo|ReactNative|React-Native/i }] });
    if (source === "Unknown") (query.$and ||= []).push({ $or: [{ source: "Unknown" },
      { source: { $in: ["", null] }, deviceInfo: { $not: /Chrome|Firefox|Safari|Edg\/|okhttp|CFNetwork|Expo|ReactNative|React-Native/i } }] });
    if (startDate || endDate || startAt || endAt) {
      query.createdAt = {};
      if (startAt && /^\d{4}-\d{2}-\d{2}T/.test(startAt) && !Number.isNaN(Date.parse(startAt))) query.createdAt.$gte = new Date(startAt);
      else if (startDate && /^\d{4}-\d{2}-\d{2}$/.test(startDate)) query.createdAt.$gte = new Date(`${startDate}T00:00:00.000Z`);
      if (endAt && /^\d{4}-\d{2}-\d{2}T/.test(endAt) && !Number.isNaN(Date.parse(endAt))) query.createdAt.$lte = new Date(endAt);
      else if (endDate && /^\d{4}-\d{2}-\d{2}$/.test(endDate)) query.createdAt.$lte = new Date(`${endDate}T23:59:59.999Z`);
    }
    const search = String(req.query.search || "").trim().slice(0, 100);
    if (search.length >= 2) {
      const regex = new RegExp(escapeRegex(search), "i");
      const [actors, players, classes, teams, leagues, products] = await Promise.all([
        Admin.find({ $or: [{ name: regex }, { email: regex }] }).select("_id").limit(100).lean(),
        require("../models/User").find({ $or: [{ fullName: regex }, { firstName: regex }, { lastName: regex }] }).select("_id").limit(100).lean(),
        require("../models/Class").find({ name: regex }).select("_id").limit(100).lean(),
        require("../models/Team").find({ teamName: regex }).select("_id").limit(100).lean(),
        require("../models/League").find({ name: regex }).select("_id").limit(100).lean(),
        require("../models/Product").find({ name: regex }).select("_id").limit(100).lean(),
      ]);
      const recordIds = [...players, ...classes, ...teams, ...leagues, ...products].map((item) => item._id);
      const playerIds = players.map((item) => item._id);
      query.$or = [{ description: regex }, { entityName: regex }, { actorName: regex }, { actorEmail: regex }, { action: regex }, { entityType: regex }, { ipAddress: regex },
        { user: { $in: actors.map((actor) => actor._id) } }, { entityId: { $in: recordIds } },
        { "newValue.player": { $in: playerIds } }, { "newValue.changes.player": { $in: playerIds } },
        { "newValue.classIds": { $in: classes.map((item) => item._id) } },
        { "newValue.teamId": { $in: teams.map((item) => item._id) } },
        { "newValue.leagueId": { $in: leagues.map((item) => item._id) } },
        { "newValue.productId": { $in: products.map((item) => item._id) } }];
    }
    const [total, logs, actions, entityTypes, actors] = await Promise.all([
      AuditLog.countDocuments(query),
      AuditLog.find(query).populate("user", "name email role").sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      AuditLog.distinct("action"), AuditLog.distinct("entityType"),
      Admin.find({ role: { $in: ["SUPER_ADMIN", "ADMIN", "COACH"] } }).select("name email role").sort({ name: 1 }).lean(),
    ]);
    const enriched = await enrich(logs);
    res.json({ success: true, total, page, limit, totalPages: Math.ceil(total / limit), data: enriched.data, resolvedNames: enriched.names,
      filters: { actions: actions.sort(), entityTypes: entityTypes.sort(), actors } });
  } catch (error) { next(error); }
};

exports.getEntityAuditLogs = async (req, res, next) => {
  try {
    const { entityType, entityId } = req.params;
    if (!mongoose.isValidObjectId(entityId)) return res.status(400).json({ message: "Invalid entity ID" });
    const logs = await AuditLog.find({ entityType, entityId }).populate("user", "name email role").sort({ createdAt: -1 }).limit(100).lean();
    const enriched = await enrich(logs);
    res.json({ success: true, total: logs.length, data: enriched.data, resolvedNames: enriched.names });
  } catch (error) { next(error); }
};
