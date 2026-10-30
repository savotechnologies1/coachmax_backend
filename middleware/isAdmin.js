const Class = require("../models/Class");
const Team = require("../models/Team");
const League = require("../models/League");
const Invoice = require("../models/Invoice");
const Payment = require("../models/Payment");
const Order = require("../models/Order");
const RegistrationRequest = require("../models/RegistrationRequest");
const { can, scopeFor, isPrivileged } = require("../utils/coachPermissions");

const moduleFor = (path) => {
  if (/^\/(?:coaches|coach\/|getAllCoaches|getCoachById|getCoachClassesWithSessions|createCoach|updateCoach|toggleCoachActive|changeCoachPassword)/.test(path)) return "coaches";
  if (/^\/assignCoachToClass/.test(path)) return "classes";
  if (/^\/(?:registration-requests|temporary-players|unallocated-players)/.test(path)) return "requests";
  if (/^\/store\/orders/.test(path)) return "orders";
  if (/^\/store\//.test(path)) return "store";
  if (/^\/invoices/.test(path)) return "invoices";
  if (/^\/(?:bank-details|payments\/settings)/.test(path)) return "bankDetails";
  if (/^\/(?:payments|updatePaymentStatus)/.test(path)) return "payments";
  if (/^\/(?:term\/[^/]+\/earnings|cloneTerm|dashboard\/term|dashboard\/payments)/.test(path)) return "reports";
  if (/^\/dashboard/.test(path)) return "dashboard";
  if (/^\/(?:leagues|fixtures|createLeague|createFixture)/.test(path)) return "leagues";
  if (/^\/(?:teams|getAllTeams|getTeamPlayers|getTeamFullTable|getTeamSessions|getAttendanceByTeam|getAttendanceByTeamDate|markTeamAttendance|markSingleTeamAttendance|exportTeamCSV|team-attendance-history|available-players)/.test(path)) return "teams";
  if (/^\/(?:getAllClasses|getAllClassesForAssign|getClass|getClassFiltersWithTimeSlots|createClass|updateClass|deleteClass|duplicateClass|getClassesByTerm|getAttendanceByClass|getAttendanceByDate|markAttendance|markSingleAttendance|exportClassCSV|attendance-history)/.test(path)) return "classes";
  if (/^\/(?:createTerm|deleteTerm|getAllTerms|getTermById|updateTerm|getCurrentYearTerms)/.test(path)) return "terms";
  if (/^\/(?:createProgram|updateProgram|deleteProgram|program\/|createCategory|updateCategory|deleteCategory)/.test(path)) return "programs";
  if (/^\/(?:getUsers|playerStats|players\/search|player\/|updatePlayer|updateRating|assignClass|removeClass|transferClass|exportUsers|player-statistics)/.test(path)) return "players";
  if (/^\/(?:createEvent|getAllEvents|updateEvent|deleteEvent|events|exportEventParticipants|getEvent)/.test(path)) return "events";
  if (/^\/(?:createBanner|updateBanner|deleteBanner|getAllBanners|toggleBannerStatus)/.test(path)) return "sponsors";
  if (/^\/news/.test(path)) return "news";
  if (/^\/(?:chat|send-notification|deleteMessage|deleteChatRoom)/.test(path)) return "communication";
  if (/^\/audit-logs/.test(path)) return "audit";
  if (/^\/sidebar-badges/.test(path)) return "dashboard";
  return null;
};

const actionFor = (method, path) => {
  if (method === "GET") return /export/i.test(path) ? "export" : "read";
  if (/export/i.test(path)) return "export";
  if (/^\/leagues\/[^/]+\/teams(?:\/[^/]+)?$/.test(path)) return "assign";
  if (/assign|unassign|transfer|removeClass|addTeamToLeague|removeTeamFromLeague/i.test(path)) return "assign";
  if (/approve|reject|complete/i.test(path)) return "approve";
  if (/attendance|statistics|recalculate|generate-random-fixtures/i.test(path) && method !== "GET") return "edit";
  if (method === "DELETE") return "delete";
  if (method === "POST") return "create";
  return "edit";
};

const assignedTeamQuery = (coachId) => ({ $or: [{ coach: coachId }, { assistantCoach: coachId }] });
const assignedPlayerIds = async (coachId) => {
  const [classes, teams] = await Promise.all([
    Class.find(assignedTeamQuery(coachId)).select("players").lean(),
    Team.find(assignedTeamQuery(coachId)).select("players.player").lean(),
  ]);
  return [...new Set([
    ...classes.flatMap((item) => item.players || []),
    ...teams.flatMap((item) => (item.players || []).map((entry) => entry.player)),
  ].filter(Boolean).map(String))];
};
const assignedInvoiceQuery = (ids) => ({ players: { $in: ids, $not: { $elemMatch: { $nin: ids } } } });
const safeAssignedLists = new Set([
  "/getUsers", "/playerStats", "/players/search", "/getAllClasses",
  "/getAllClassesForAssign", "/getClassFiltersWithTimeSlots", "/getAllTeams",
  "/leagues", "/invoices", "/payments", "/store/orders", "/available-players",
]);

const ownsResource = async (req, module) => {
  const coachId = req.admin._id;
  const params = req.params || {};
  const query = req.query || {};
  const body = req.body || {};
  const id = params.id || params.classId || params.teamId || params.leagueId || params.playerId || params.userId ||
    query.classId || query.teamId || query.leagueId || body.classId || body.teamId || body.leagueId;
  if (!id) return null;
  if (module === "classes") return Boolean(await Class.exists({ _id: id, ...assignedTeamQuery(coachId) }));
  if (module === "teams") return Boolean(await Team.exists({ _id: id, ...assignedTeamQuery(coachId) }));
  if (module === "players") return (await assignedPlayerIds(coachId)).includes(String(id));
  if (module === "leagues") {
    const teamIds = await Team.find(assignedTeamQuery(coachId)).distinct("_id");
    return Boolean(await League.exists({ _id: id, teams: { $in: teamIds } }));
  }
  if (module === "invoices") return Boolean(await Invoice.exists({ _id: id, ...assignedInvoiceQuery(await assignedPlayerIds(coachId)) }));
  if (module === "payments") {
    if (/^\/updatePaymentStatus\//.test(req.path)) {
      if (!(await assignedPlayerIds(coachId)).includes(String(params.userId))) return false;
      if (body.classId && !await Class.exists({ _id: body.classId, ...assignedTeamQuery(coachId) })) return false;
      if (body.teamId && !await Team.exists({ _id: body.teamId, ...assignedTeamQuery(coachId), "players.player": params.userId })) return false;
      const leagueId = body.leagueId || query.leagueId;
      if (leagueId) {
        const teamIds = await Team.find(assignedTeamQuery(coachId)).distinct("_id");
        if (!await League.exists({ _id: leagueId, teams: { $in: teamIds } })) return false;
      }
      return true;
    }
    const invoiceIds = await Invoice.find(assignedInvoiceQuery(await assignedPlayerIds(coachId))).distinct("_id");
    return Boolean(await Payment.exists({ _id: id, invoice: { $in: invoiceIds } }));
  }
  if (module === "orders") {
    const invoiceIds = await Invoice.find(assignedInvoiceQuery(await assignedPlayerIds(coachId))).distinct("_id");
    return Boolean(await Order.exists({ _id: id, invoice: { $in: invoiceIds } }));
  }
  return false;
};

const isAdmin = async (req, res, next) => {
  if (!req.admin || req.admin.isActive === false) return res.status(403).json({ message: "Active staff access required" });
  if (isPrivileged(req.admin) || (req.admin.role === "COACH" && req.admin.accessMode === "FULL")) return next();
  const path = req.path || "";
  const module = moduleFor(path);
  const action = path === "/bank-details" && req.method === "POST" && can(req.admin, "bankDetails", "edit")
    ? "edit" : actionFor(req.method, path);
  if (path === "/getAllCoaches" && req.method === "GET" && !can(req.admin, "coaches", "read") &&
    (["classes", "teams"].some((area) => can(req.admin, area, "create") || can(req.admin, area, "edit") || can(req.admin, area, "assign")))) {
    req.staffCoachOptionsOnly = true;
    return next();
  }
  if (!module || !can(req.admin, module, action)) return res.status(403).json({ message: "This coach permission is disabled" });
  const scope = scopeFor(req.admin, module);
  req.staffScope = { module, scope, coachId: req.admin._id };
  if (scope === "ALL" || module === "requests") return next();
  if (["terms", "programs", "news"].includes(module)) {
    return action === "read" ? next() : res.status(403).json({ message: "All-record access is required for this action" });
  }
  if (["dashboard", "reports", "coaches", "audit", "store", "communication", "events"].includes(module)) {
    return res.status(403).json({ message: "All-record access is required for this screen" });
  }
  try {
    if ((/^\/player\/[^/]+\/assign-classes$/.test(path) || /^\/assignClass\//.test(path)) && action === "assign") {
      if (!can(req.admin, "requests", "assign")) return res.status(403).json({ message: "Request assignment is disabled" });
      const classIds = /^\/assignClass\//.test(path) ? [req.body?.classId] : req.body?.classIds;
      if (!Array.isArray(classIds) || classIds.length === 0 || classIds.length > 20) return res.status(400).json({ message: "Select valid classes" });
      const assignedClasses = await Class.countDocuments({ _id: { $in: classIds }, ...assignedTeamQuery(req.admin._id) });
      if (assignedClasses !== new Set(classIds.map(String)).size) return res.status(403).json({ message: "Select only classes assigned to this coach" });
      const request = await RegistrationRequest.findOne({
        _id: req.body?.registrationRequestId,
        player: req.params.playerId || req.params.userId,
        status: "PENDING",
      }).select("_id");
      if (!request) return res.status(403).json({ message: "A pending request for this player is required" });
      return next();
    }
    if (/^\/(?:removeClass|transferClass)/.test(path) && action === "assign") {
      const playerId = req.params.userId || req.body?.userId || req.body?.playerId;
      const classIds = path.startsWith("/removeClass") ? [req.body?.classId] : [req.body?.fromClassId, req.body?.toClassId];
      if (!playerId || classIds.some((value) => !value)) return res.status(400).json({ message: "Player and class IDs are required" });
      if (!(await assignedPlayerIds(req.admin._id)).includes(String(playerId))) return res.status(403).json({ message: "Player is not assigned to you" });
      const count = await Class.countDocuments({ _id: { $in: classIds }, ...assignedTeamQuery(req.admin._id) });
      if (count !== new Set(classIds.map(String)).size) return res.status(403).json({ message: "Select only assigned classes" });
      return next();
    }
    const owned = await ownsResource(req, module);
    if (owned === false) return res.status(403).json({ message: "This record is not assigned to you" });
    if (module === "leagues" && action !== "read") {
      const membershipPath = /^\/leagues\/[^/]+\/teams(?:\/[^/]+)?$/.test(path);
      const teamDetailPath = /^\/leagues\/[^/]+\/teams\/[^/]+\/(?:statistics|status)$/.test(path);
      if (!membershipPath && !teamDetailPath) return res.status(403).json({ message: "All-record access is required to change this league" });
      const teamIds = [...new Set([
        req.params.teamId,
        req.body?.teamId,
        ...(Array.isArray(req.body?.teamIds) ? req.body.teamIds : []),
      ].filter(Boolean).map(String))];
      if (!teamIds.length) return res.status(400).json({ message: "Select a team" });
      const count = await Team.countDocuments({ _id: { $in: teamIds }, ...assignedTeamQuery(req.admin._id) });
      if (count !== teamIds.length) return res.status(403).json({ message: "Only assigned teams can be changed in this league" });
      return next();
    }
    if (owned === true && module === "teams" && /\/assign$/.test(path)) {
      if (!can(req.admin, "players", "assign")) return res.status(403).json({ message: "Player assignment is disabled" });
      let rows = req.body?.players;
      if (typeof rows === "string") {
        try { rows = JSON.parse(rows); } catch { return res.status(400).json({ message: "Invalid players" }); }
      }
      if (!Array.isArray(rows) || !rows.length) return res.status(400).json({ message: "Select players" });
      const allowed = new Set(await assignedPlayerIds(req.admin._id));
      if (rows.some((row) => !allowed.has(String(row?.playerId || row?.player || row?._id || row)))) {
        return res.status(403).json({ message: "Only assigned players can be added to this team" });
      }
    }
    if (owned === null && action === "read" && !safeAssignedLists.has(path) && !/^\/getClassesByTerm\//.test(path)) {
      return res.status(403).json({ message: "Assigned-only access does not cover this screen" });
    }
    if (owned === null && action !== "read") {
      if (action === "create" && ["classes", "teams"].includes(module)) {
        req.body.coach = String(req.admin._id);
      } else if (action === "create" && module === "invoices") {
        const supplied = Array.isArray(req.body?.players) && req.body.players.length
          ? req.body.players : [req.body?.playerId || req.body?.userId].filter(Boolean);
        const assignedIds = new Set(await assignedPlayerIds(req.admin._id));
        if (!supplied.length || supplied.some((value) => !assignedIds.has(String(value)))) {
          return res.status(403).json({ message: "Only assigned players can be invoiced" });
        }
        if (req.body?.classId || req.body?.class) {
          const classId = req.body.classId || req.body.class;
          if (!await Class.exists({ _id: classId, ...assignedTeamQuery(req.admin._id) })) return res.status(403).json({ message: "Class is not assigned to you" });
        }
        if (req.body?.teamId || req.body?.team) {
          const teamId = req.body.teamId || req.body.team;
          if (!await Team.exists({ _id: teamId, ...assignedTeamQuery(req.admin._id) })) return res.status(403).json({ message: "Team is not assigned to you" });
        }
      } else {
        return res.status(403).json({ message: "Assigned-only access does not cover this action" });
      }
    }
    return next();
  } catch (error) { return next(error); }
};

module.exports = isAdmin;
module.exports.assignedPlayerIds = assignedPlayerIds;
module.exports.assignedTeamQuery = assignedTeamQuery;
module.exports.assignedInvoiceQuery = assignedInvoiceQuery;
