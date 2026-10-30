const mongoose = require("mongoose");
const User = require("../models/User");
const Class = require("../models/Class");
const Team = require("../models/Team");
const League = require("../models/League");
const Product = require("../models/Product");
const Event = require("../models/Event");
const Program = require("../models/Program");
const Term = require("../models/Term");
const News = require("../models/News");
const Admin = require("../models/Admin");
const Invoice = require("../models/Invoice");
const Order = require("../models/Order");
const { can, scopeFor } = require("../utils/coachPermissions");
const { assignedPlayerIds, assignedTeamQuery, assignedInvoiceQuery } = require("../middleware/isAdmin");

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const result = (type, title, subtitle, path, state) => ({ type, title: String(title || ""), subtitle: String(subtitle || ""), path, ...(state ? { state } : {}) });
const ownOrAll = (admin, module) => can(admin, module, "read") && scopeFor(admin, module) === "ALL";

exports.globalSearch = async (req, res, next) => {
  const q = typeof req.query.q === "string" ? req.query.q.trim().replace(/\s+/g, " ") : "";
  if (q.length < 2 || q.length > 80) {
    return res.status(400).json({ message: "Search must contain 2 to 80 characters" });
  }

  try {
    const staff = req.admin;
    const regex = new RegExp(escapeRegex(q), "i");
    const groups = [];
    const jobs = [];
    const add = (label, run) => jobs.push(run().then((items) => {
      if (items.length) groups.push({ label, items });
    }));
    let playerIds;
    let teamIds;
    let invoiceIds;
    const getPlayerIds = async () => playerIds ||= await assignedPlayerIds(staff._id);
    const getTeamIds = async () => teamIds ||= await Team.find(assignedTeamQuery(staff._id)).distinct("_id");
    const getInvoiceIds = async () => invoiceIds ||= await Invoice.find(assignedInvoiceQuery(await getPlayerIds())).distinct("_id");
    const matchId = mongoose.isValidObjectId(q) ? { _id: q } : null;

    if (can(staff, "players", "read")) add("Players", async () => {
      const scope = scopeFor(staff, "players") === "ALL" ? {} : { _id: { $in: await getPlayerIds() } };
      const docs = await User.find({ ...scope, $or: [{ fullName: regex }, { firstName: regex }, { lastName: regex }, { email: regex }] })
        .select("fullName firstName lastName email").limit(5).lean();
      return docs.map((doc) => result("player", doc.fullName || [doc.firstName, doc.lastName].filter(Boolean).join(" "), doc.email || "Player", `/player/${doc._id}`));
    });
    if (can(staff, "classes", "read")) add("Classes", async () => {
      const scope = scopeFor(staff, "classes") === "ALL" ? {} : assignedTeamQuery(staff._id);
      const docs = await Class.find({ ...scope, $or: [{ name: regex }, { location: regex }, { venue: regex }] })
        .select("name dayOfWeek location category program term").populate("term", "year").limit(5).lean();
      return docs.map((doc) => result("class", doc.name || "Training class", [doc.dayOfWeek, doc.location].filter(Boolean).join(" · "), "/classes", {
        classId: String(doc._id),
        categoryId: String(doc.category || ""),
        programId: String(doc.program || ""),
        termId: String(doc.term?._id || ""),
        year: doc.term?.year,
        viewAll: true,
      }));
    });
    if (can(staff, "teams", "read")) add("Teams", async () => {
      const scope = scopeFor(staff, "teams") === "ALL" ? {} : assignedTeamQuery(staff._id);
      const docs = await Team.find({ ...scope, archivedAt: null, $or: [{ teamName: regex }, { ageGroup: regex }] })
        .select("teamName ageGroup").limit(5).lean();
      return docs.map((doc) => result("team", doc.teamName, doc.ageGroup || "Team", `/teams/${doc._id}`));
    });
    if (can(staff, "leagues", "read")) add("Leagues", async () => {
      const scope = scopeFor(staff, "leagues") === "ALL" ? {} : { teams: { $in: await getTeamIds() } };
      const docs = await League.find({ ...scope, archivedAt: null, $or: [{ name: regex }, { season: regex }, ...(matchId ? [matchId] : [])] })
        .select("name season").limit(5).lean();
      return docs.map((doc) => result("league", doc.name, doc.season || "League", `/leagues/${doc._id}`));
    });
    if (ownOrAll(staff, "store")) add("Products", async () => {
      const docs = await Product.find({ $or: [{ name: regex }, { shortHighlight: regex }, ...(matchId ? [matchId] : [])] })
        .select("name shortHighlight").limit(5).lean();
      return docs.map((doc) => result("product", doc.name, doc.shortHighlight || "Product", `/products/${doc._id}`));
    });
    if (ownOrAll(staff, "events")) add("Events", async () => {
      const docs = await Event.find({ isArchived: { $ne: true }, $or: [{ title: regex }, { venueName: regex }, { category: regex }] })
        .select("title venueName category").limit(5).lean();
      return docs.map((doc) => result("event", doc.title, doc.venueName || doc.category || "Event", `/event-details/${doc._id}`));
    });
    if (can(staff, "programs", "read")) add("Programs", async () => {
      const docs = await Program.find({ name: regex }).select("name ageGroup").limit(5).lean();
      return docs.map((doc) => result("program", doc.name, doc.ageGroup || "Program", "/programs"));
    });
    if (can(staff, "terms", "read")) add("Terms", async () => {
      const numericYear = /^\d{4}$/.test(q) ? Number(q) : null;
      const docs = await Term.find({ $or: [{ name: regex }, ...(numericYear ? [{ year: numericYear }] : [])] })
        .select("name year").limit(5).lean();
      return docs.map((doc) => result("term", doc.name, doc.year, "/coaching-management"));
    });
    if (ownOrAll(staff, "news")) add("News", async () => {
      const docs = await News.find({ $or: [{ title: regex }, { category: regex }] }).select("title category").limit(5).lean();
      return docs.map((doc) => result("news", doc.title, doc.category || "News", `/news/${doc._id}`));
    });
    if (ownOrAll(staff, "coaches")) add("Coaches", async () => {
      const docs = await Admin.find({ role: "COACH", $or: [{ name: regex }, { email: regex }] })
        .select("name email").limit(5).lean();
      return docs.map((doc) => result("coach", doc.name, doc.email || "Coach", `/coaches/${doc._id}`));
    });
    if (can(staff, "invoices", "read")) add("Invoices", async () => {
      const scope = scopeFor(staff, "invoices") === "ALL" ? {} : { _id: { $in: await getInvoiceIds() } };
      const docs = await Invoice.find({ ...scope, internalType: { $ne: "SEQUENCE" }, $or: [{ invoiceNumber: regex }, ...(matchId ? [matchId] : [])] })
        .select("invoiceNumber status").limit(5).lean();
      return docs.map((doc) => result("invoice", doc.invoiceNumber, doc.status || "Invoice", `/invoices/${doc._id}`));
    });
    if (can(staff, "orders", "read") && matchId) add("Orders", async () => {
      const scope = scopeFor(staff, "orders") === "ALL" ? {} : { invoice: { $in: await getInvoiceIds() } };
      const docs = await Order.find({ ...scope, ...matchId }).select("status").limit(5).lean();
      return docs.map((doc) => result("order", `Order ${String(doc._id).slice(-8)}`, doc.status || "Order", `/orders/${doc._id}`));
    });

    await Promise.all(jobs);
    const order = ["Players", "Classes", "Teams", "Leagues", "Products", "Events", "Programs", "Terms", "News", "Coaches", "Invoices", "Orders"];
    groups.sort((a, b) => order.indexOf(a.label) - order.indexOf(b.label));
    res.json({ query: q, groups });
  } catch (error) { next(error); }
};
