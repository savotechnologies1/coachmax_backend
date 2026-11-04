const mongoose = require("mongoose");
const Class = require("../models/Class");
const Event = require("../models/Event");
const EventRegistration = require("../models/EventRegistration");
const League = require("../models/League");
const Team = require("../models/Team");
const User = require("../models/User");
const EmailCampaign = require("../models/EmailCampaign");
const EmailCampaignRecipient = require("../models/EmailCampaignRecipient");
const { queueEmail } = require("../services/deliveryService");

const TYPES = new Set(["CLASS", "EVENT", "TOURNAMENT"]);
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const idString = (value) => String(value?._id || value || "");
const isObjectId = (value) => mongoose.Types.ObjectId.isValid(String(value || ""));
const escapeHtml = (value = "") => String(value).replace(/[&<>"']/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[character]));
const fullName = (player) => player.fullName || [player.firstName, player.lastName].filter(Boolean).join(" ").trim() || "Player";

const getAudience = async (type, id) => {
  if (!TYPES.has(type) || !isObjectId(id)) return { error: "Choose a valid audience." };

  if (type === "CLASS") {
    const record = await Class.findById(id).populate("term", "name year").populate("program", "name").populate("category", "name").lean();
    if (!record) return { error: "Class not found." };
    return { record, name: [record.name || "Class", record.category?.name, record.program?.name, record.term?.name].filter(Boolean).join(" · ") };
  }
  if (type === "EVENT") {
    const record = await Event.findOne({ _id: id, isArchived: { $ne: true } }).lean();
    if (!record) return { error: "Event not found." };
    return { record, name: record.title || "Event" };
  }
  const record = await League.findOne({ _id: id, archivedAt: null }).lean();
  if (!record) return { error: "Tournament not found." };
  return { record, name: record.name || "Tournament" };
};

const getAudiencePlayers = async (type, audience) => {
  let ids = [];
  if (type === "CLASS") {
    ids = audience.players || [];
  } else if (type === "EVENT") {
    ids = await EventRegistration.find({ event: audience._id, status: "REGISTERED" }).distinct("user");
  } else {
    const teams = await Team.find({ _id: { $in: audience.teams || [] }, teamType: { $ne: "EXTERNAL" } })
      .select("players.player leagues.league leagues.status leagues.players.player leagues.players.status")
      .lean();
    teams.forEach((team) => {
      const leagueRoster = (team.leagues || []).find((entry) => idString(entry.league) === idString(audience._id));
      if (leagueRoster?.status === "WITHDRAWN") return;
      const roster = leagueRoster?.players?.length
        ? leagueRoster.players.filter((entry) => entry.status !== "INACTIVE" && entry.status !== "SUSPENDED").map((entry) => entry.player)
        : (team.players || []).map((entry) => entry.player);
      ids.push(...roster.filter(Boolean));
    });
  }

  const uniqueIds = [...new Set(ids.map(idString).filter(isObjectId))];
  return User.find({ _id: { $in: uniqueIds } })
    .select("fullName firstName lastName email parentId")
    .populate("parentId", "fullName email notificationSettings")
    .lean();
};

const resolveRecipients = (players) => {
  const deliverableByEmail = new Map();
  const skipped = [];
  for (const player of players) {
    const parent = player.parentId;
    const email = String(parent?.email || "").trim().toLowerCase();
    const name = fullName(player);
    const recipientName = parent?.fullName || "Parent/Guardian";
    const contact = {
      playerIds: [player._id], playerNames: [name], recipientName,
      recipientEmail: email,
    };
    if (!parent || !email) {
      skipped.push({ ...contact, recipientEmail: "", status: "SKIPPED", skipReason: "Parent/guardian email is not available." });
      continue;
    }
    if (!EMAIL_PATTERN.test(email)) {
      skipped.push({ ...contact, status: "SKIPPED", skipReason: "Parent/guardian email address is invalid." });
      continue;
    }
    if (parent.notificationSettings?.email === false) {
      skipped.push({ ...contact, status: "SKIPPED", skipReason: "Parent/guardian email notifications are turned off." });
      continue;
    }
    const existing = deliverableByEmail.get(email);
    if (existing) {
      existing.playerIds.push(player._id);
      existing.playerNames.push(name);
    } else {
      deliverableByEmail.set(email, { ...contact, status: "QUEUED", skipReason: "" });
    }
  }
  return { deliverable: [...deliverableByEmail.values()], skipped };
};

const selectedPlayersForRequest = async (req, res) => {
  const { audienceType, audienceId } = req.body;
  const audience = await getAudience(audienceType, audienceId);
  if (audience.error) {
    res.status(400).json({ success: false, message: audience.error });
    return null;
  }
  const allPlayers = await getAudiencePlayers(audienceType, audience.record);
  const byId = new Map(allPlayers.map((player) => [idString(player._id), player]));
  let selected;
  if (req.body.selectAll === true) {
    const excluded = Array.isArray(req.body.excludedPlayerIds) ? req.body.excludedPlayerIds.map(String) : [];
    selected = allPlayers.filter((player) => !excluded.includes(idString(player._id)));
  } else {
    const ids = [...new Set((Array.isArray(req.body.playerIds) ? req.body.playerIds : []).map(String))];
    if (!ids.length) {
      res.status(400).json({ success: false, message: "Select at least one player." });
      return null;
    }
    const invalid = ids.filter((id) => !byId.has(id));
    if (invalid.length) {
      res.status(400).json({ success: false, message: "One or more selected players are not in this audience." });
      return null;
    }
    selected = ids.map((id) => byId.get(id));
  }
  if (!selected.length) {
    res.status(400).json({ success: false, message: "There are no players selected in this audience." });
    return null;
  }
  return { audience, players: selected };
};

exports.getEmailAudiences = async (_req, res) => {
  try {
    const [classes, events, tournaments] = await Promise.all([
      Class.find({}).select("name term program category").populate("term", "name year").populate("program", "name").populate("category", "name").sort({ name: 1 }).lean(),
      Event.find({ isArchived: { $ne: true } }).select("title startDate endDate eventType status").sort({ startDate: -1 }).lean(),
      League.find({ archivedAt: null }).select("name season year term termScope status teams startDate").populate("term", "name year").sort({ createdAt: -1 }).lean(),
    ]);
    const yearFrom = (value) => {
      const match = String(value || "").match(/\b(19|20)\d{2}\b/);
      return match ? match[0] : "";
    };
    res.json({ success: true, data: {
      classes: classes.map((item) => ({
        _id: item._id,
        name: [item.name || "Class", item.category?.name, item.program?.name, item.term?.name].filter(Boolean).join(" · "),
        year: String(item.term?.year || ""),
        termId: idString(item.term),
        termName: item.term?.name || "",
        categoryId: idString(item.category),
        categoryName: item.category?.name || "",
        programId: idString(item.program),
        programName: item.program?.name || "",
      })),
      events: events.map((item) => ({
        _id: item._id,
        name: item.title || "Event",
        startDate: item.startDate,
        endDate: item.endDate,
        status: item.status || "UPCOMING",
        year: yearFrom(item.startDate) || yearFrom(item.endDate),
      })),
      tournaments: tournaments.map((item) => ({
        _id: item._id,
        name: [item.name, item.season].filter(Boolean).join(" · "),
        status: item.status,
        year: String(item.term?.year || item.year || yearFrom(item.season) || yearFrom(item.startDate)),
        termId: idString(item.term),
        termName: item.term?.name || "",
      })),
    } });
  } catch (error) {
    console.error("getEmailAudiences failed", error.message);
    res.status(500).json({ success: false, message: "Could not load email audiences." });
  }
};

exports.getEmailAudiencePlayers = async (req, res) => {
  try {
    const { audienceType, audienceId } = req.query;
    const audience = await getAudience(audienceType, audienceId);
    if (audience.error) return res.status(400).json({ success: false, message: audience.error });
    const players = await getAudiencePlayers(audienceType, audience.record);
    const resolved = resolveRecipients(players);
    const contactByPlayer = new Map();
    resolved.deliverable.forEach((recipient) => recipient.playerIds.forEach((id) => contactByPlayer.set(idString(id), { email: recipient.recipientEmail, status: "AVAILABLE", recipientName: recipient.recipientName })));
    resolved.skipped.forEach((recipient) => recipient.playerIds.forEach((id) => contactByPlayer.set(idString(id), { email: recipient.recipientEmail, status: "SKIPPED", recipientName: recipient.recipientName, reason: recipient.skipReason })));
    let rows = players.map((player) => {
      const contact = contactByPlayer.get(idString(player._id)) || { email: "", status: "SKIPPED", reason: "Parent/guardian email is not available." };
      return { playerId: player._id, playerName: fullName(player), recipientName: contact.recipientName || "Parent/Guardian", email: contact.email, contactStatus: contact.status, reason: contact.reason || "" };
    });
    const search = String(req.query.search || "").trim().toLowerCase();
    if (search) rows = rows.filter((row) => [row.playerName, row.recipientName, row.email].some((value) => String(value || "").toLowerCase().includes(search)));
    const contactFilter = String(req.query.contactStatus || "ALL").toUpperCase();
    if (contactFilter === "AVAILABLE" || contactFilter === "SKIPPED") rows = rows.filter((row) => row.contactStatus === contactFilter);
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(500, Math.max(10, Number(req.query.limit) || 100));
    res.json({ success: true, data: {
      audience: { type: audienceType, id: audienceId, name: audience.name },
      players: rows.slice((page - 1) * limit, page * limit),
      total: rows.length,
      page,
      limit,
      counts: {
        players: players.length,
        availablePlayers: players.filter((player) => contactByPlayer.get(idString(player._id))?.status === "AVAILABLE").length,
        missingOrOptedOut: players.filter((player) => contactByPlayer.get(idString(player._id))?.status !== "AVAILABLE").length,
        deliverableRecipients: resolved.deliverable.length,
      },
    } });
  } catch (error) {
    console.error("getEmailAudiencePlayers failed", error.message);
    res.status(500).json({ success: false, message: "Could not load audience players." });
  }
};

exports.previewEmailCampaign = async (req, res) => {
  try {
    const selected = await selectedPlayersForRequest(req, res);
    if (!selected) return;
    const recipients = resolveRecipients(selected.players);
    res.json({ success: true, data: {
      audienceName: selected.audience.name,
      selectedPlayers: selected.players.length,
      deliverableRecipients: recipients.deliverable.length,
      skippedPlayers: recipients.skipped.reduce((count, row) => count + row.playerIds.length, 0),
      skippedReasons: [...new Set(recipients.skipped.map((row) => row.skipReason))],
    } });
  } catch (error) {
    console.error("previewEmailCampaign failed", error.message);
    res.status(500).json({ success: false, message: "Could not preview this email." });
  }
};

const renderEmail = ({ parentName, playerNames, message }) => {
  const greeting = escapeHtml(parentName || "Parent/Guardian");
  const children = playerNames.map(escapeHtml).join(", ");
  const content = escapeHtml(message).replace(/\r?\n/g, "<br>");
  return `<div style="margin:0;background:#f5f7fb;padding:24px;font-family:Arial,sans-serif;color:#152238"><div style="max-width:640px;margin:auto;background:#fff;border:1px solid #dbe3ef"><div style="background:#07194f;color:#fff;padding:18px 24px;font-weight:700;font-size:20px">COACH <span style="color:#ef233c">MAX</span></div><div style="padding:24px"><p>Hello ${greeting},</p><p>This message relates to ${children || "your player"}.</p><div style="line-height:1.65">${content}</div><p style="margin-top:28px">CoachMax Football Academy</p></div></div></div>`;
};

exports.createEmailCampaign = async (req, res) => {
  try {
    const subject = String(req.body.subject || "").trim();
    const message = String(req.body.message || "").trim();
    if (!subject || subject.length > 180 || !message || message.length > 12000) return res.status(400).json({ success: false, message: "Enter a subject and a message under 12,000 characters." });
    const selected = await selectedPlayersForRequest(req, res);
    if (!selected) return;
    if (selected.players.length > 1000) return res.status(400).json({ success: false, message: "A single campaign can include up to 1,000 players." });
    const recipients = resolveRecipients(selected.players);
    const campaign = await EmailCampaign.create({
      createdBy: req.admin._id,
      audienceType: req.body.audienceType,
      audienceId: selected.audience.record._id,
      audienceName: selected.audience.name,
      subject,
      message,
      selectedPlayerCount: selected.players.length,
    });
    const recipientRows = [
      ...recipients.deliverable,
      ...recipients.skipped,
    ].map((recipient) => ({ campaign: campaign._id, queuedAt: recipient.status === "QUEUED" ? new Date() : null, ...recipient }));
    const createdRecipients = recipientRows.length ? await EmailCampaignRecipient.insertMany(recipientRows) : [];
    let queuedRecipients = 0;
    let queueFailures = 0;
    const queueable = createdRecipients.filter((row) => row.status === "QUEUED");
    for (let offset = 0; offset < queueable.length; offset += 25) {
      const batch = queueable.slice(offset, offset + 25);
      const results = await Promise.all(batch.map(async (recipient) => {
        try {
          const html = renderEmail({ parentName: recipient.recipientName, playerNames: recipient.playerNames, message });
          await queueEmail(`campaign:${campaign._id}:${recipient._id}`, {
            to: recipient.recipientEmail,
            subject,
            html,
            campaignId: String(campaign._id),
            campaignRecipientId: String(recipient._id),
          });
          return true;
        } catch (_error) {
          await EmailCampaignRecipient.updateOne({ _id: recipient._id }, { $set: { status: "FAILED", lastError: "Could not add this email to the delivery queue." } });
          return false;
        }
      }));
      queuedRecipients += results.filter(Boolean).length;
      queueFailures += results.filter((result) => !result).length;
    }
    const responseMessage = queueFailures
      ? queuedRecipients
        ? "Some recipient emails could not be queued. Review the failed records in campaign history."
        : "No recipient emails could be queued. Review the failed records in campaign history."
      : queuedRecipients
        ? "Email campaign queued."
        : "Campaign recorded with no deliverable email addresses.";
    res.status(201).json({ success: true, message: responseMessage, data: {
      campaignId: campaign._id,
      audienceName: campaign.audienceName,
      selectedPlayers: selected.players.length,
      queuedRecipients,
      skippedPlayers: recipients.skipped.reduce((count, row) => count + row.playerIds.length, 0),
      skippedRecords: recipients.skipped.length,
      queueFailures,
    } });
  } catch (error) {
    console.error("createEmailCampaign failed", {
      name: error.name,
      code: error.code,
      message: error.message,
    });
    res.status(500).json({ success: false, message: "Could not queue this email campaign." });
  }
};

const countStatuses = async (campaignIds) => {
  if (!campaignIds.length) return new Map();
  const values = await EmailCampaignRecipient.aggregate([
    { $match: { campaign: { $in: campaignIds } } },
    { $group: { _id: { campaign: "$campaign", status: "$status" }, count: { $sum: 1 } } },
  ]);
  const map = new Map();
  values.forEach((row) => {
    const id = idString(row._id.campaign);
    const current = map.get(id) || { queued: 0, sending: 0, sent: 0, failed: 0, skipped: 0 };
    const statusKey = String(row._id.status || "").toLowerCase();
    if (statusKey in current) current[statusKey] = row.count;
    map.set(id, current);
  });
  return map;
};
const campaignState = (counts) => {
  if (counts.queued + counts.sending > 0) return "IN_QUEUE";
  if (counts.sent && (counts.failed || counts.skipped)) return "PARTIAL";
  if (counts.failed) return "FAILED";
  if (counts.sent) return "SENT";
  return "SKIPPED";
};
const serializeCampaign = (campaign, counts = {}) => {
  const normalized = { queued: 0, sending: 0, sent: 0, failed: 0, skipped: 0, ...counts };
  return {
    _id: campaign._id,
    audienceType: campaign.audienceType,
    audienceId: campaign.audienceId,
    audienceName: campaign.audienceName,
    subject: campaign.subject,
    message: campaign.message,
    selectedPlayerCount: campaign.selectedPlayerCount,
    createdBy: campaign.createdBy,
    createdAt: campaign.createdAt,
    updatedAt: campaign.updatedAt,
    counts: normalized,
    state: campaignState(normalized),
  };
};

exports.getEmailCampaigns = async (req, res) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(10, Number(req.query.limit) || 25));
    const search = String(req.query.search || "").trim();
    const audienceType = String(req.query.audienceType || "ALL").toUpperCase();
    const query = search ? { $or: [
      { subject: { $regex: search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), $options: "i" } },
      { audienceName: { $regex: search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), $options: "i" } },
    ] } : {};
    if (TYPES.has(audienceType)) query.audienceType = audienceType;
    const [campaigns, total] = await Promise.all([
      EmailCampaign.find(query).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).populate("createdBy", "name email").lean(),
      EmailCampaign.countDocuments(query),
    ]);
    const counts = await countStatuses(campaigns.map((item) => item._id));
    const overviewRows = await EmailCampaignRecipient.aggregate([
      { $group: { _id: "$status", count: { $sum: 1 } } },
    ]);
    const overview = { queued: 0, sending: 0, sent: 0, failed: 0, skipped: 0 };
    overviewRows.forEach((row) => {
      const key = String(row._id || "").toLowerCase();
      if (key in overview) overview[key] = row.count;
    });
    res.json({ success: true, data: campaigns.map((item) => serializeCampaign(item, counts.get(idString(item._id)))), overview, page, limit, total });
  } catch (error) {
    console.error("getEmailCampaigns failed", error.message);
    res.status(500).json({ success: false, message: "Could not load email history." });
  }
};

exports.getEmailCampaignDetails = async (req, res) => {
  try {
    if (!isObjectId(req.params.campaignId)) return res.status(400).json({ success: false, message: "Invalid campaign ID." });
    const campaign = await EmailCampaign.findById(req.params.campaignId).populate("createdBy", "name email").lean();
    if (!campaign) return res.status(404).json({ success: false, message: "Email campaign not found." });
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(250, Math.max(10, Number(req.query.limit) || 100));
    const status = String(req.query.status || "ALL").toUpperCase();
    const recipientQuery = { campaign: campaign._id };
    if (["QUEUED", "SENDING", "SENT", "FAILED", "SKIPPED"].includes(status)) recipientQuery.status = status;
    const [recipients, total, counts] = await Promise.all([
      EmailCampaignRecipient.find(recipientQuery).sort({ createdAt: 1 }).skip((page - 1) * limit).limit(limit).lean(),
      EmailCampaignRecipient.countDocuments(recipientQuery),
      countStatuses([campaign._id]),
    ]);
    res.json({ success: true, data: { campaign: serializeCampaign(campaign, counts.get(idString(campaign._id))), recipients, page, limit, total } });
  } catch (error) {
    console.error("getEmailCampaignDetails failed", error.message);
    res.status(500).json({ success: false, message: "Could not load campaign details." });
  }
};

exports.retryFailedEmailRecipients = async (req, res) => {
  try {
    if (!isObjectId(req.params.campaignId)) return res.status(400).json({ success: false, message: "Invalid campaign ID." });
    const campaign = await EmailCampaign.findById(req.params.campaignId);
    if (!campaign) return res.status(404).json({ success: false, message: "Email campaign not found." });
    const failed = await EmailCampaignRecipient.find({ campaign: campaign._id, status: "FAILED" }).lean();
    let queued = 0;
    for (const oldRecipient of failed) {
      const claimed = await EmailCampaignRecipient.findOneAndUpdate({ _id: oldRecipient._id, status: "FAILED" }, { $set: { status: "QUEUED", queuedAt: new Date(), nextAttemptAt: null, lastError: "" } }, { new: true });
      if (!claimed) continue;
      try {
        await queueEmail(`campaign:${campaign._id}:${claimed._id}:retry:${Date.now()}`, {
          to: claimed.recipientEmail,
          subject: campaign.subject,
          html: renderEmail({ parentName: claimed.recipientName, playerNames: claimed.playerNames, message: campaign.message }),
          campaignId: String(campaign._id),
          campaignRecipientId: String(claimed._id),
        });
        queued += 1;
      } catch (_error) {
        await EmailCampaignRecipient.updateOne({ _id: claimed._id }, { $set: { status: "FAILED", lastError: "Could not add this email to the delivery queue." } });
      }
    }
    res.json({ success: true, message: `${queued} failed email${queued === 1 ? "" : "s"} queued for retry.`, data: { queued } });
  } catch (error) {
    console.error("retryFailedEmailRecipients failed", error.message);
    res.status(500).json({ success: false, message: "Could not retry failed emails." });
  }
};
