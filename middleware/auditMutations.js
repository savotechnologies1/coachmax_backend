const mongoose = require("mongoose");
const AuditLog = require("../models/AuditLog");
const { clientIp, deviceInfo } = require("../utils/sessionInfo");
const auditContext = require("../utils/auditContext");

const categories = [
  [/attendance/i, "Attendance"], [/registration-request|unallocated/i, "RegistrationRequest"],
  [/payment|transaction/i, "Payment"], [/invoice/i, "Invoice"], [/order/i, "Order"],
  [/^\/(?:teams|team|createTeam|updateTeam|deleteTeam)/i, "Team"],
  [/^\/(?:leagues|league|createLeague|updateLeague|deleteLeague|fixtures|fixture)/i, "League"],
  [/product|store/i, "Product"], [/temporary-player|player|user|assignClass|removeClass|transferClass/i, "User"], [/coach|profile|password/i, "Admin"],
  [/class|training/i, "Class"], [/team/i, "Team"], [/league|fixture|match/i, "League"],
  [/term/i, "Term"], [/program|category/i, "Program"], [/event|camp/i, "Event"],
  [/news|gallery/i, "News"],
  [/note/i, "CoachNote"], [/chat|message|broadcast/i, "Communication"],
];
const modelFor = { User: "User", Admin: "Admin", Class: "Class", Team: "Team", League: "League", Term: "Term", Program: "Program", Event: "Event", Product: "Product", Order: "Order", Invoice: "Invoice", News: "News" };
const nameOf = (doc) => doc?.fullName || [doc?.firstName, doc?.lastName].filter(Boolean).join(" ") || doc?.teamName || doc?.name || doc?.title || doc?.invoiceNumber || "";
const parseEntityId = (req, result) => {
  const params = req.params || {};
  const responseRecords = [result?.data, result?.program, result?.term, result?.player, result?.team, result?.coach, result?.event, result?.product, result?.league].flat().filter(Boolean);
  const responseId = responseRecords.find((item) => mongoose.isValidObjectId(item?._id || item?.id));
  const candidate = params.playerId || params.userId || params.classId || params.teamId || params.leagueId || params.coachId || params.id ||
    req.body?.playerId || req.body?.classId || req.body?.teamId || responseId?._id || responseId?.id || result?._id || result?.id ||
    req.path.match(/\b[a-f0-9]{24}\b/i)?.[0];
  return mongoose.isValidObjectId(candidate) ? candidate : null;
};

module.exports = (req, res, next) => {
  const isExport = req.method === "GET" && /export|download/i.test(req.path);
  if ((!isExport && !["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) || /^(\/login|\/logout|\/sessions|\/coaches\/[^/]+\/sessions)/.test(req.path)) return next();
  const context = { wrote: false };
  return auditContext.run(context, () => {
  const path = req.path;
  const entityType = categories.find(([pattern]) => pattern.test(path))?.[1] || "System";
  const possibleId = parseEntityId(req);
  const Model = modelFor[entityType] ? require(`../models/${modelFor[entityType]}`) : null;
  const before = Model && possibleId ? Model.findById(possibleId).select("fullName firstName lastName teamName name title invoiceNumber").lean().catch(() => null) : Promise.resolve(null);
  let responseBody;
  const json = res.json.bind(res);
  res.json = (body) => { responseBody = body; return json(body); };
  res.once("finish", () => {
    if (res.statusCode < 200 || res.statusCode >= 300 || responseBody?.success === false || !req.admin) return;
    (async () => {
      // Existing controller entries have richer transaction details; retain those instead of duplicating them.
      if (context.wrote) return;
      const bulkRecords = req.method === "POST" && Array.isArray(responseBody?.data) ? responseBody.data.slice(0, 50) : [];
      const bulkIds = bulkRecords.map((record) => record?._id || record?.id).filter((id) => mongoose.isValidObjectId(id));
      const ids = bulkIds.length > 1 ? bulkIds : [parseEntityId(req, responseBody) || possibleId || req.admin._id];
      const beforeDoc = await before;
      const afterDocs = Model ? await Model.find({ _id: { $in: ids } }).select("fullName firstName lastName teamName name title invoiceNumber").lean().catch(() => []) : [];
      const byId = new Map(afterDocs.map((doc) => [String(doc._id), doc]));
      const action = isExport ? "EXPORTED" : /attendance/i.test(path) ? "ATTENDANCE_UPDATED" : /profile/i.test(path) ? "PROFILE_UPDATED" : /assign|allocate|transfer/i.test(path) ? "ASSIGNMENT_UPDATED" : /approve|reject/i.test(path) ? "REQUEST_DECIDED"
        : req.method === "DELETE" ? "DELETED" : req.method === "POST" ? "CREATED" : "UPDATED";
      const typeLabel = entityType.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
      const verb = action === "EXPORTED" ? "exported" : action === "DELETED" ? "deleted" : action === "CREATED" ? "created" : action === "ATTENDANCE_UPDATED" ? "updated attendance for"
        : action === "ASSIGNMENT_UPDATED" ? "updated assignments for" : action === "REQUEST_DECIDED" ? "decided" : "updated";
      const device = deviceInfo(req);
      await AuditLog.create(ids.map((id) => {
        const entityName = nameOf(byId.get(String(id))) || nameOf(beforeDoc) || String(req.body?.name || req.body?.fullName || req.body?.teamName || req.body?.title || "").slice(0, 120);
        return { user: req.admin._id, userRole: req.admin.role, actorName: req.admin.name || "", actorEmail: req.admin.email || "", action, entityType, entityId: id,
          entityName, source: device.source, description: `${req.admin.name || req.admin.email} ${verb} ${typeLabel}${entityName ? ` ${entityName}` : ""}`,
          ipAddress: clientIp(req), deviceInfo: device.userAgent };
      }));
    })().catch((error) => console.error("Audit entry could not be written", { message: error.message }));
  });
  if (req.method === "DELETE" && Model && possibleId) before.then(() => next(), () => next());
  else next();
  });
};
