const mongoose = require("mongoose");
const Attendance = require("../models/Attendance");
const Class = require("../models/Class");
const Team = require("../models/Team");
const AuditLog = require("../models/AuditLog");
const { dateOnly, dateOnlyStartUtc } = require("../utils/dateTime");
const { generateClassSessions } = require("../utils/classSessionDates");
const { clientIp, deviceInfo } = require("../utils/sessionInfo");

const fail = (message, status = 400) => {
  throw Object.assign(new Error(message), { status });
};

exports.updateClassSessionDay = async (req, res, next) => {
  try {
    if (!req.admin || !["COACH", "ADMIN", "SUPER_ADMIN"].includes(req.admin.role) || req.admin.isActive === false) {
      return res.status(403).json({ success: false, message: "Active staff access required" });
    }

    const { classId } = req.params;
    const { sessionDate, action } = req.body || {};
    if (!mongoose.isValidObjectId(classId)) fail("Invalid class ID");
    const normalizedDate = dateOnly(sessionDate, "sessionDate");
    const sessionStart = dateOnlyStartUtc(normalizedDate, "sessionDate");
    if (!sessionStart) fail("Session date is required");
    if (!["NOTE", "CANCEL", "RESTORE"].includes(action)) fail("Choose a valid class-day action");

    const note = typeof req.body.note === "string" ? req.body.note.trim() : "";
    const reason = typeof req.body.reason === "string" ? req.body.reason.trim() : "";
    if (note.length > 1000) fail("Admin notes must be 1,000 characters or fewer");
    if (action === "CANCEL" && !reason) fail("Enter a reason for cancelling this class");
    if (reason.length > 500) fail("Cancellation reasons must be 500 characters or fewer");

    const classDoc = await Class.findById(classId).populate("term", "startDate endDate status");
    if (!classDoc) fail("Class not found", 404);
    if (req.admin.role === "COACH" && ![classDoc.coach, classDoc.assistantCoach].some((staffId) => String(staffId?._id || staffId || "") === String(req.admin._id))) {
      fail("You are not assigned to this class", 403);
    }
    if (classDoc.isArchived || classDoc.status === "INACTIVE") fail("This class is not active", 409);
    if (classDoc.term?.status === "COMPLETED") fail("This class term is completed and read-only", 409);

    const isScheduledDate = generateClassSessions(classDoc.term, classDoc)
      .some((date) => dateOnly(date) === normalizedDate);
    if (!isScheduledDate) fail("The selected date is not scheduled for this class");

    const attendance = await Attendance.findOneAndUpdate(
      { class: classId, sessionDate: sessionStart },
      { $setOnInsert: { class: classId, sessionDate: sessionStart, records: [] } },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );

    if (action === "NOTE") {
      attendance.sessionNote = note;
      attendance.sessionNoteAuthor = req.admin._id;
      attendance.sessionNoteUpdatedAt = new Date();
    } else if (action === "CANCEL") {
      attendance.sessionStatus = "CANCELLED";
      attendance.sessionCancellationReason = reason;
      attendance.sessionCancelledBy = req.admin._id;
      attendance.sessionCancelledAt = new Date();
    } else {
      attendance.sessionStatus = "SCHEDULED";
      attendance.sessionCancellationReason = "";
      attendance.sessionCancelledBy = undefined;
      attendance.sessionCancelledAt = undefined;
    }

    await attendance.save();

    const description = action === "NOTE"
      ? `Admin day note ${note ? "updated" : "cleared"} for ${classDoc.name} on ${normalizedDate}`
      : action === "CANCEL"
        ? `${classDoc.name} cancelled on ${normalizedDate}: ${reason}`
        : `${classDoc.name} cancellation reversed on ${normalizedDate}`;
    const audit = deviceInfo(req);
    await AuditLog.create({
      user: req.admin._id,
      userRole: req.admin.role,
      actorName: req.admin.name || req.admin.fullName || "",
      actorEmail: req.admin.email || "",
      action: action === "NOTE" ? "CLASS_SESSION_NOTE_UPDATED" : action === "CANCEL" ? "CLASS_SESSION_CANCELLED" : "CLASS_SESSION_RESTORED",
      entityType: "Attendance",
      entityId: attendance._id,
      entityName: `${classDoc.name} · ${normalizedDate}`,
      description,
      newValue: { sessionDate: normalizedDate, action, note: action === "NOTE" ? note : undefined, reason: action === "CANCEL" ? reason : undefined },
      ipAddress: clientIp(req),
      deviceInfo: audit.userAgent,
      source: audit.source,
    });

    return res.json({
      success: true,
      message: action === "NOTE" ? "Admin note saved" : action === "CANCEL" ? "Class session cancelled" : "Class session restored",
      data: {
        sessionDate: normalizedDate,
        status: attendance.sessionStatus || "SCHEDULED",
        cancellationReason: attendance.sessionCancellationReason || "",
        note: attendance.sessionNote || "",
      },
    });
  } catch (error) {
    if (error.status || error.statusCode || error instanceof TypeError) {
      return res.status(error.status || error.statusCode || 400).json({ success: false, message: error.message });
    }
    return next(error);
  }
};

exports.updateTeamSessionDay = async (req, res, next) => {
  try {
    if (!req.admin || !["COACH", "ADMIN", "SUPER_ADMIN"].includes(req.admin.role) || req.admin.isActive === false) {
      return res.status(403).json({ success: false, message: "Active staff access required" });
    }

    const { teamId } = req.params;
    const { sessionDate, action, leagueId: requestedLeagueId } = req.body || {};
    if (!mongoose.isValidObjectId(teamId)) fail("Invalid team ID");
    if (requestedLeagueId && !mongoose.isValidObjectId(requestedLeagueId)) fail("Invalid tournament ID");
    const normalizedDate = dateOnly(sessionDate, "sessionDate");
    const sessionStart = dateOnlyStartUtc(normalizedDate, "sessionDate");
    if (!sessionStart) fail("Session date is required");
    if (!["NOTE", "CANCEL", "RESTORE"].includes(action)) fail("Choose a valid team-day action");

    const note = typeof req.body.note === "string" ? req.body.note.trim() : "";
    const reason = typeof req.body.reason === "string" ? req.body.reason.trim() : "";
    if (note.length > 1000) fail("Admin notes must be 1,000 characters or fewer");
    if (action === "CANCEL" && !reason) fail("Enter a reason for cancelling this team session");
    if (reason.length > 500) fail("Cancellation reasons must be 500 characters or fewer");

    const team = await Team.findById(teamId).populate("term", "startDate endDate status").populate("leagues.league", "sessionDates numberOfRounds startDate endDate term");
    if (!team) fail("Team not found", 404);
    if (req.admin.role === "COACH" && ![team.coach, team.assistantCoach].some((staffId) => String(staffId?._id || staffId || "") === String(req.admin._id))) {
      fail("You are not assigned to this team", 403);
    }
    if (team.isArchived || team.status === "INACTIVE") fail("This team is not active", 409);

    const selectedLeague = requestedLeagueId
      ? (team.leagues || []).find((entry) => String(entry.league?._id || entry.league || "") === String(requestedLeagueId))
      : (team.leagues || []).find((entry) => entry.status === "ACTIVE") || (team.leagues || [])[0];
    if (requestedLeagueId && (!selectedLeague || selectedLeague.status === "WITHDRAWN")) fail("Team is not enrolled in this tournament", 409);
    if (team.term?.status === "COMPLETED" && selectedLeague?.league?.term !== null) fail("This team term is completed and read-only", 409);

    const leagueSessionDates = selectedLeague?.sessionDates?.length
      ? selectedLeague.sessionDates
      : (selectedLeague?.league?.sessionDates || []);
    const sessionDates = leagueSessionDates.length ? leagueSessionDates : (team.sessionDates || []);
    const round = selectedLeague?.round ?? selectedLeague?.league?.numberOfRounds ?? team.round;
    const sessionConfig = {
      ...team.toObject(), sessionDates, round,
      startDate: selectedLeague?.league?.startDate || team.startDate || null,
      endDate: selectedLeague?.league?.endDate || team.endDate || null,
    };
    const attendanceTerm = selectedLeague?.league?.term === null ? null : team.term;
    const isScheduledDate = generateClassSessions(attendanceTerm, sessionConfig)
      .some((date) => dateOnly(date) === normalizedDate);
    if (!isScheduledDate) fail("The selected date is not scheduled for this team");

    const leagueId = requestedLeagueId || selectedLeague?.league?._id || selectedLeague?.league || null;
    const attendance = await Attendance.findOneAndUpdate(
      { team: teamId, league: leagueId, sessionDate: sessionStart },
      { $setOnInsert: { team: teamId, league: leagueId, sessionDate: sessionStart, records: [] } },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );

    if (action === "NOTE") {
      attendance.sessionNote = note;
      attendance.sessionNoteAuthor = req.admin._id;
      attendance.sessionNoteUpdatedAt = new Date();
    } else if (action === "CANCEL") {
      attendance.sessionStatus = "CANCELLED";
      attendance.sessionCancellationReason = reason;
      attendance.sessionCancelledBy = req.admin._id;
      attendance.sessionCancelledAt = new Date();
    } else {
      attendance.sessionStatus = "SCHEDULED";
      attendance.sessionCancellationReason = "";
      attendance.sessionCancelledBy = undefined;
      attendance.sessionCancelledAt = undefined;
    }

    await attendance.save();
    const description = action === "NOTE"
      ? `Admin day note ${note ? "updated" : "cleared"} for ${team.teamName} on ${normalizedDate}`
      : action === "CANCEL"
        ? `${team.teamName} session cancelled on ${normalizedDate}: ${reason}`
        : `${team.teamName} session cancellation reversed on ${normalizedDate}`;
    const audit = deviceInfo(req);
    await AuditLog.create({
      user: req.admin._id,
      userRole: req.admin.role,
      actorName: req.admin.name || req.admin.fullName || "",
      actorEmail: req.admin.email || "",
      action: action === "NOTE" ? "TEAM_SESSION_NOTE_UPDATED" : action === "CANCEL" ? "TEAM_SESSION_CANCELLED" : "TEAM_SESSION_RESTORED",
      entityType: "Attendance",
      entityId: attendance._id,
      entityName: `${team.teamName} · ${normalizedDate}`,
      description,
      newValue: { sessionDate: normalizedDate, action, leagueId, note: action === "NOTE" ? note : undefined, reason: action === "CANCEL" ? reason : undefined },
      ipAddress: clientIp(req),
      deviceInfo: audit.userAgent,
      source: audit.source,
    });

    return res.json({
      success: true,
      message: action === "NOTE" ? "Admin note saved" : action === "CANCEL" ? "Team session cancelled" : "Team session restored",
      data: {
        sessionDate: normalizedDate,
        status: attendance.sessionStatus || "SCHEDULED",
        cancellationReason: attendance.sessionCancellationReason || "",
        note: attendance.sessionNote || "",
      },
    });
  } catch (error) {
    if (error.status || error.statusCode || error instanceof TypeError) {
      return res.status(error.status || error.statusCode || 400).json({ success: false, message: error.message });
    }
    return next(error);
  }
};
