const mongoose = require("mongoose");
const Invoice = require("../models/Invoice");
const Payment = require("../models/Payment");
const AuditLog = require("../models/AuditLog");
const Parent = require("../models/Parent");
const User = require("../models/User");
const BankDetails = require("../models/BankDetails");
const PaymentSettings = require("../models/PaymentSettings");
const Notification = require("../models/Notification");
const { sendNotification } = require("../services/notificationService");
const { formatDateOnly } = require("../utils/dateTime");
const { clientIp, deviceInfo } = require("../utils/sessionInfo");
const auditContext = require("../utils/auditContext");

const getOrCreatePaymentSettings = async () => {
  let settings = await PaymentSettings.findOne();
  if (!settings) {
    settings = await PaymentSettings.create({
      isOnlineEnabled: true,
      isCodEnabled: true,
    });
  }
  return settings;
};


// Helper to generate sequential invoice number e.g. INV-2026-000001
const { generateInvoiceNumber } = require("../services/invoiceService");

exports.createInvoice = async (req, res) => {
  try {
    const {
      parentId,
      players = [],
      playerId,
      userId,
      classId,
      class: classRef,
      teamId,
      team: teamRef,
      items = [],
      dueDate,
      description = "",
      notes = "",
      discount = 0,
      type = "CUSTOM",
      totalAmount: customTotalAmount,
    } = req.body;

    if (!parentId || !dueDate) {
      return res.status(400).json({
        success: false,
        message: "parentId and dueDate are required",
      });
    }

    const parent = await Parent.findById(parentId);
    if (!parent) {
      return res.status(404).json({
        success: false,
        message: "Parent not found",
      });
    }

    const rawPlayerList = (Array.isArray(players) && players.length > 0)
      ? players
      : (playerId || userId ? [playerId || userId] : []);
    const playerArray = Array.isArray(rawPlayerList) ? rawPlayerList : [rawPlayerList];

    if (playerArray.length > 0) {
      const dbPlayers = await User.find({ _id: { $in: playerArray } });
      if (dbPlayers.length !== playerArray.length) {
        return res.status(400).json({
          success: false,
          message: "One or more player IDs are invalid",
        });
      }
      for (const p of dbPlayers) {
        if (p.parentId && p.parentId.toString() !== parentId.toString()) {
          return res.status(400).json({
            success: false,
            message: `Player '${p.fullName || p.firstName}' does not belong to the selected parent`,
          });
        }
      }
    }

    const processedItems = (Array.isArray(items) ? items : []).map((item) => ({
      title: item.title || item.description || "Invoice Item",
      description: item.description || "",
      amount: Number(item.amount || 0),
    }));

    const calculatedSubtotal = processedItems.reduce((acc, item) => acc + item.amount, 0);
    const numDiscount = Number(discount || 0);

    let finalTotal = customTotalAmount !== undefined && customTotalAmount !== null
      ? Number(customTotalAmount)
      : Math.max(0, calculatedSubtotal - numDiscount);

    if (finalTotal === 0 && calculatedSubtotal === 0 && req.body.amount) {
      finalTotal = Number(req.body.amount);
    }

    const invoiceNumber = await generateInvoiceNumber();
    const assignedClassId = classId || classRef || null;
    const assignedTeamId = teamId || teamRef || null;

    const invoice = await Invoice.create({
      invoiceNumber,
      parent: parentId,
      players: playerArray,
      class: assignedClassId,
      team: assignedTeamId,
      items: processedItems,
      subtotal: calculatedSubtotal,
      discount: numDiscount,
      totalAmount: finalTotal,
      amount: finalTotal,
      dueDate: new Date(dueDate),
      type: type || "CUSTOM",
      description,
      notes,
      paymentStatus: "UNPAID",
      status: "ACTIVE",
    });

    if (playerArray.length > 0 && assignedClassId) {
      const playersToUpdate = await User.find({ _id: { $in: playerArray } });
      for (const p of playersToUpdate) {
        p.classPaymentStatuses = p.classPaymentStatuses || [];
        const existingEntry = p.classPaymentStatuses.find(
          (cps) => cps.class && cps.class.toString() === assignedClassId.toString()
        );
        if (existingEntry) {
          existingEntry.paymentStatus = "UNPAID";
        } else {
          p.classPaymentStatuses.push({
            class: assignedClassId,
            paymentStatus: "UNPAID",
          });
        }
        await p.save();
      }
    }

    if (assignedTeamId && playerArray.length > 0) {
      try {
        const Team = require("../models/Team");
        const teamDoc = await Team.findById(assignedTeamId);
        if (teamDoc && teamDoc.players) {
          let modified = false;
          playerArray.forEach((pId) => {
            const pidStr = pId.toString();
            const pEntry = teamDoc.players.find((item) => {
              const itemPid = item.player ? item.player.toString() : item.toString();
              return itemPid === pidStr;
            });
            if (pEntry) {
              pEntry.paymentStatus = "UNPAID";
              modified = true;
            }
          });
          if (modified) await teamDoc.save();
        }
      } catch (err) {
        console.error("Failed to update team paymentStatus on invoice creation:", err.message);
      }
    }

    try {
      await sendNotification({
        recipientType: "PARENT",
        parentId: parentId,
        title: "New Invoice Issued 📄",
        message: `An invoice #${invoiceNumber} for amount ${finalTotal} has been issued. Due date: ${formatDateOnly(dueDate)}.`,
        type: "INVOICE_CREATED",
        data: {
          parentId: String(parentId),
          invoiceId: String(invoice._id),
          invoiceNumber: String(invoiceNumber),
          totalAmount: String(finalTotal),
          dueDate: new Date(dueDate).toISOString(),
        },
      });
    } catch (notifErr) {
      console.error("Notification creation failed:", notifErr.message);
    }

    const populatedInvoice = await Invoice.findById(invoice._id)
      .populate("parent", "fullName email phone")
      .populate("players", "firstName lastName fullName gender category")
      .populate("class", "name price dayOfWeek startTime endTime venue location")
      .populate("team", "teamName teamType teamFee logo");

    return res.status(201).json({
      success: true,
      message: "Invoice created successfully",
      data: populatedInvoice,
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: err.message,
    });
  }
};

exports.getAdminInvoices = async (req, res) => {
  try {
    const {
      search = "",
      status,
      paymentStatus,
      type,
      parent,
      startDate,
      endDate,
      page = 1,
      limit = 10,
    } = req.query;

    const query = {};
    if (req.staffScope?.scope === "ASSIGNED") {
      const ids = await require("../middleware/isAdmin").assignedPlayerIds(req.admin._id);
      Object.assign(query, require("../middleware/isAdmin").assignedInvoiceQuery(ids));
    }

    if (status) query.status = status;
    if (paymentStatus) query.paymentStatus = paymentStatus;
    if (type) query.type = type;
    if (parent) query.parent = parent;

    if (startDate || endDate) {
      query.createdAt = {};
      if (startDate) query.createdAt.$gte = new Date(startDate);
      if (endDate) query.createdAt.$lte = new Date(endDate);
    }

    let searchParentIds = [];
    let searchPlayerIds = [];

    if (search) {
      const searchRegex = new RegExp(search, "i");

      const [matchingParents, matchingPlayers] = await Promise.all([
        Parent.find({
          $or: [{ fullName: searchRegex }, { email: searchRegex }, { phone: searchRegex }],
        }).select("_id"),
        User.find({
          $or: [{ fullName: searchRegex }, { firstName: searchRegex }, { lastName: searchRegex }],
        }).select("_id"),
      ]);

      searchParentIds = matchingParents.map((p) => p._id);
      searchPlayerIds = matchingPlayers.map((p) => p._id);

      query.$or = [
        { invoiceNumber: searchRegex },
        { description: searchRegex },
        { parent: { $in: searchParentIds } },
        { players: { $in: searchPlayerIds } },
      ];
    }

    const currentPage = Math.max(1, parseInt(page, 10) || 1);
    const pageLimit = Math.max(1, parseInt(limit, 10) || 10);
    const skip = (currentPage - 1) * pageLimit;

    const [invoices, total] = await Promise.all([
      Invoice.find(query)
        .select("+adminAdjustmentAmount")
        .populate("parent", "fullName email phone emergencyContact")
        .populate("players", "firstName lastName fullName category")
        .populate("class", "name price dayOfWeek startTime endTime venue location")
        .populate("team", "teamName teamType teamFee logo")
        .populate("verifiedBy", "name email")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(pageLimit),
      Invoice.countDocuments(query),
    ]);

    return res.status(200).json({
      success: true,
      count: invoices.length,
      pagination: {
        page: currentPage,
        limit: pageLimit,
        total,
        pages: Math.ceil(total / pageLimit),
      },
      data: invoices,
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: err.message,
    });
  }
};

exports.getAdminInvoiceById = async (req, res) => {
  try {
    const { id } = req.params;

    const invoice = await Invoice.findById(id)
      .select("+adminAdjustmentAmount")
      .populate("parent", "fullName email phone emergencyContact relationship")
      .populate("players", "firstName lastName fullName gender category assignedClasses")
      .populate("class", "name price dayOfWeek startTime endTime venue location")
      .populate("team", "teamName teamType teamFee logo")
      .populate("verifiedBy", "name email");

    if (!invoice) {
      return res.status(404).json({
        success: false,
        message: "Invoice not found",
      });
    }

    return res.status(200).json({
      success: true,
      data: invoice,
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: err.message,
    });
  }
};

exports.updateInvoice = async (req, res) => {
  let session;
  try {
    const { id } = req.params;
    const {
      players,
      items,
      dueDate,
      description,
      notes,
      discount,
      status,
      paymentStatus,
      type,
      totalAmount,
      adjustmentReason,
    } = req.body;

    const hasPriceEdits = items !== undefined || discount !== undefined || totalAmount !== undefined;
    const reason = typeof adjustmentReason === "string" ? adjustmentReason.trim() : "";
    if (hasPriceEdits && (reason.length < 8 || reason.length > 500)) {
      return res.status(400).json({
        success: false,
        message: "Add an admin adjustment note of 8 to 500 characters, for example: Joined halfway through the term — 50% discount.",
      });
    }

    const requestedTotal = totalAmount === undefined ? undefined : Number(totalAmount);
    if (requestedTotal !== undefined && (!Number.isFinite(requestedTotal) || requestedTotal < 0)) {
      return res.status(400).json({ success: false, message: "Invoice total must be a valid non-negative amount." });
    }

    session = await mongoose.startSession();
    session.startTransaction();

    const invoice = await Invoice.findById(id).select("+adminAdjustmentAmount").session(session);
    if (!invoice) {
      await session.abortTransaction();
      return res.status(404).json({
        success: false,
        message: "Invoice not found",
      });
    }

    const requestedPaymentStatus = paymentStatus
      ? String(paymentStatus).trim().toUpperCase()
      : null;
    const normalizedPaymentStatus = requestedPaymentStatus === "OVERDUE" || requestedPaymentStatus === "OVER_DUE"
      ? "UNPAID"
      : requestedPaymentStatus;
    if (normalizedPaymentStatus && !["UNPAID", "PAID", "PAYMENT_PENDING", "REJECTED", "CANCELLED"].includes(normalizedPaymentStatus)) {
      await session.abortTransaction();
      return res.status(400).json({
        success: false,
        message: "Invalid invoice payment status",
      });
    }

    if (normalizedPaymentStatus === "PAID") {
      await session.abortTransaction();
      return res.status(409).json({
        success: false,
        message: "Invoices cannot be marked paid by editing their status. Record or approve a payment transaction so the invoice and ledger reconcile together.",
      });
    }

    const hasInvoiceEdits = Boolean(players || items || dueDate || description !== undefined || notes !== undefined || discount !== undefined || status || type || totalAmount !== undefined);
    const hasApprovedPayments = await Payment.exists({ invoice: invoice._id, status: "APPROVED" }).session(session);
    const hasPendingPayments = await Payment.exists({ invoice: invoice._id, status: "PENDING" }).session(session);
    const hasFinancialEdits = Boolean(players || items || discount !== undefined || type || totalAmount !== undefined);
    if (hasPriceEdits && invoice.status !== "ACTIVE") {
      await session.abortTransaction();
      return res.status(409).json({ success: false, message: "Only active invoices can be adjusted." });
    }
    if (hasApprovedPayments && (hasFinancialEdits || normalizedPaymentStatus || status === "CANCELLED")) {
      await session.abortTransaction();
      return res.status(409).json({
        success: false,
        message: "This invoice has approved receipts. Correct the payment through a refund or adjustment workflow before changing its amount or payment status.",
      });
    }
    if (hasPendingPayments && (hasFinancialEdits || normalizedPaymentStatus || status === "CANCELLED")) {
      await session.abortTransaction();
      return res.status(409).json({
        success: false,
        message: "This invoice has a pending payment transaction. Resolve it before changing the invoice amount or payment status.",
      });
    }
    if (invoice.paymentStatus === "PAID" && (hasInvoiceEdits || (normalizedPaymentStatus && normalizedPaymentStatus !== "PAID"))) {
      await session.abortTransaction();
      return res.status(409).json({
        success: false,
        message: "Cannot modify a paid invoice",
      });
    }

    const previousFinancials = {
      subtotal: Number(invoice.subtotal) || 0,
      discount: Number(invoice.discount) || 0,
      totalAmount: Number(invoice.totalAmount ?? invoice.amount) || 0,
      adminAdjustmentAmount: Number(invoice.adminAdjustmentAmount) || 0,
    };

    if (players && Array.isArray(players)) {
      invoice.players = players;
    }

    if (items && Array.isArray(items)) {
      invoice.items = items.map((item) => ({
        title: item.title || item.description || "Invoice Item",
        description: item.description || "",
        amount: Number(item.amount || 0),
      }));
      invoice.subtotal = invoice.items.reduce((acc, i) => acc + i.amount, 0);
    }

    if (discount !== undefined) invoice.discount = Number(discount);
    if (dueDate) invoice.dueDate = new Date(dueDate);
    if (description !== undefined) invoice.description = description;
    if (notes !== undefined) invoice.notes = notes;
    if (status) invoice.status = status;
    if (type) invoice.type = type;
    if (normalizedPaymentStatus) invoice.paymentStatus = normalizedPaymentStatus;

    if (requestedTotal !== undefined) {
      const roundedTotal = Math.round(requestedTotal * 100) / 100;
      const baseTotal = Number(invoice.subtotal || 0) - Number(invoice.discount || 0);
      invoice.adminAdjustmentAmount = Math.round((roundedTotal - baseTotal) * 100) / 100;
      invoice.totalAmount = roundedTotal;
      invoice.amount = roundedTotal;
    } else if (items !== undefined || discount !== undefined) {
      const calculatedTotal = Number(invoice.subtotal || 0) - Number(invoice.discount || 0) + Number(invoice.adminAdjustmentAmount || 0);
      if (!Number.isFinite(calculatedTotal) || calculatedTotal < 0) {
        await session.abortTransaction();
        return res.status(400).json({ success: false, message: "Invoice adjustments cannot make the total negative." });
      }
      invoice.totalAmount = Math.round(calculatedTotal * 100) / 100;
      invoice.amount = invoice.totalAmount;
    }

    const currentFinancials = {
      subtotal: Number(invoice.subtotal) || 0,
      discount: Number(invoice.discount) || 0,
      totalAmount: Number(invoice.totalAmount ?? invoice.amount) || 0,
      adminAdjustmentAmount: Number(invoice.adminAdjustmentAmount) || 0,
    };
    const financialsChanged = Object.keys(previousFinancials).some((key) => previousFinancials[key] !== currentFinancials[key]);

    await invoice.save({ session });

    if (hasPriceEdits && financialsChanged) {
      const device = deviceInfo(req);
      await AuditLog.create([{
        user: req.admin?._id,
        userRole: req.admin?.role || "ADMIN",
        actorName: req.admin?.name || "",
        actorEmail: req.admin?.email || "",
        action: "INVOICE_AMOUNT_ADJUSTED",
        entityType: "Invoice",
        entityId: invoice._id,
        entityName: invoice.invoiceNumber || String(invoice._id),
        source: device.source,
        ipAddress: clientIp(req),
        deviceInfo: device.userAgent,
        oldValue: previousFinancials,
        newValue: { ...currentFinancials, reason },
        description: `Invoice amount changed from $${previousFinancials.totalAmount.toFixed(2)} to $${currentFinancials.totalAmount.toFixed(2)}. Admin note: ${reason}`,
      }], { session });
      const context = auditContext.getStore();
      if (context) context.wrote = true;
    }

    await session.commitTransaction();

    const updatedInvoice = await Invoice.findById(id)
      .select("+adminAdjustmentAmount")
      .populate("parent", "fullName email phone")
      .populate("players", "firstName lastName fullName")
      .populate("class", "name price dayOfWeek startTime endTime venue location")
      .populate("team", "teamName teamType teamFee logo");

    return res.status(200).json({
      success: true,
      message: "Invoice updated successfully",
      data: updatedInvoice,
    });
  } catch (err) {
    if (session?.inTransaction()) await session.abortTransaction();
    return res.status(err.status || 500).json({
      success: false,
      message: err.message,
    });
  } finally {
    if (session) await session.endSession();
  }
};

exports.deleteInvoice = async (req, res) => {
  try {
    const { id } = req.params;

    const invoice = await Invoice.findById(id);
    if (!invoice) {
      return res.status(404).json({
        success: false,
        message: "Invoice not found",
      });
    }

    if (await Payment.exists({ invoice: invoice._id, status: { $in: ["APPROVED", "PENDING"] } })) {
      return res.status(409).json({
        success: false,
        message: "This invoice has an approved or pending transaction and cannot be cancelled. Resolve or refund the payment first.",
      });
    }

    if (invoice.paymentStatus === "PAID") {
      return res.status(400).json({
        success: false,
        message: "Cannot cancel a paid invoice",
      });
    }

    invoice.status = "CANCELLED";
    invoice.paymentStatus = "CANCELLED";
    await invoice.save();

    return res.status(200).json({
      success: true,
      message: "Invoice cancelled successfully",
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: err.message,
    });
  }
};

exports.getParentInvoices = async (req, res) => {
  try {
    const parentId = req.parent._id;
    const { status, paymentStatus, page = 1, limit = 10 } = req.query;

    const query = { parent: parentId };
    if (status) query.status = status;
    if (paymentStatus) query.paymentStatus = paymentStatus;

    const currentPage = Math.max(1, parseInt(page, 10) || 1);
    const pageLimit = Math.max(1, parseInt(limit, 10) || 10);
    const skip = (currentPage - 1) * pageLimit;

    const [invoices, total, activeBankDetails, paymentSettings] = await Promise.all([
      Invoice.find(query)
        .populate("players", "firstName lastName fullName category assignedClasses")
        .populate("class", "name price dayOfWeek startTime endTime venue location")
        .populate("team", "teamName teamType teamFee logo")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(pageLimit),
      Invoice.countDocuments(query),
      BankDetails.findOne({ isActive: true }).sort({ updatedAt: -1 }),
      getOrCreatePaymentSettings(),
    ]);

    return res.status(200).json({
      success: true,
      count: invoices.length,
      pagination: {
        page: currentPage,
        limit: pageLimit,
        total,
        pages: Math.ceil(total / pageLimit),
      },
      data: invoices,
      bankDetails: activeBankDetails || null,
      paymentSettings: {
        isOnlineEnabled: paymentSettings.isOnlineEnabled,
        isCodEnabled: paymentSettings.isCodEnabled,
        allowedPaymentMethods: [
          ...(paymentSettings.isOnlineEnabled ? ["ONLINE"] : []),
          ...(paymentSettings.isCodEnabled ? ["COD"] : []),
        ],
      },
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: err.message,
    });
  }
};

exports.getParentInvoiceById = async (req, res) => {
  try {
    const parentId = req.parent._id;
    const { id } = req.params;

    const invoice = await Invoice.findOne({ _id: id, parent: parentId })
      .populate("players", "firstName lastName fullName category assignedClasses")
      .populate("class", "name price dayOfWeek startTime endTime venue location")
      .populate("team", "teamName teamType teamFee logo");

    if (!invoice) {
      return res.status(404).json({
        success: false,
        message: "Invoice not found or unauthorized",
      });
    }

    const [activeBankDetails, paymentSettings] = await Promise.all([
      BankDetails.findOne({ isActive: true }).sort({ updatedAt: -1 }),
      getOrCreatePaymentSettings(),
    ]);

    return res.status(200).json({
      success: true,
      data: invoice,
      bankDetails: activeBankDetails || null,
      paymentSettings: {
        isOnlineEnabled: paymentSettings.isOnlineEnabled,
        isCodEnabled: paymentSettings.isCodEnabled,
        allowedPaymentMethods: [
          ...(paymentSettings.isOnlineEnabled ? ["ONLINE"] : []),
          ...(paymentSettings.isCodEnabled ? ["COD"] : []),
        ],
      },
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: err.message,
    });
  }
};

exports.generateInvoiceNumber = generateInvoiceNumber;
