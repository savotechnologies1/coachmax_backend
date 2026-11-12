const mongoose = require("mongoose");
const Payment = require("../models/Payment");
const Invoice = require("../models/Invoice");
const Parent = require("../models/Parent");
const User = require("../models/User");
const Order = require("../models/Order");
const Notification = require("../models/Notification");
const BankDetails = require("../models/BankDetails");
const PaymentSettings = require("../models/PaymentSettings");
const { sendNotification } = require("../services/notificationService");
const { recordAdminPaymentForInvoice, syncPaidInvoiceEffects } = require("../services/adminPaymentService");
let broadcastSidebarBadges = null;
try {
  ({ broadcastSidebarBadges } = require("../sockets/chatSocket"));
} catch (e) {}

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
exports.getOrCreatePaymentSettings = getOrCreatePaymentSettings;

async function createPendingInvoicePayment({ invoiceId, parentId, paymentMethod, transactionId = "", paymentScreenshot = "", remarks = "" }) {
  const session = await mongoose.startSession();
  let payment;
  try {
    await session.withTransaction(async () => {
      const invoice = await Invoice.findOneAndUpdate(
        { _id: invoiceId, parent: parentId, status: "ACTIVE", paymentStatus: { $nin: ["PAID", "PAYMENT_PENDING"] } },
        { $set: { paymentMethod, paymentStatus: "PAYMENT_PENDING" } },
        { new: true, session }
      );
      if (!invoice) throw Object.assign(new Error("A payment has already been submitted or this invoice is no longer payable"), { status: 409 });
      [payment] = await Payment.create([{
        invoice: invoice._id,
        parent: parentId,
        amount: invoice.totalAmount,
        paymentMethod,
        transactionId,
        paymentScreenshot,
        remarks,
        status: "PENDING",
      }], { session });
    });
    return payment;
  } finally {
    await session.endSession();
  }
}

exports.getPaymentSettings = async (req, res) => {
  try {
    const settings = await getOrCreatePaymentSettings();
    return res.status(200).json({
      success: true,
      data: {
        isOnlineEnabled: settings.isOnlineEnabled,
        isCodEnabled: settings.isCodEnabled,
        allowedPaymentMethods: [
          ...(settings.isOnlineEnabled ? ["ONLINE"] : []),
          ...(settings.isCodEnabled ? ["COD"] : []),
        ],
        updatedAt: settings.updatedAt,
      },
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: err.message,
    });
  }
};

exports.updatePaymentSettings = async (req, res) => {
  try {
    const { isOnlineEnabled, isCodEnabled } = req.body;

    const settings = await getOrCreatePaymentSettings();

    if (isOnlineEnabled !== undefined) {
      settings.isOnlineEnabled = Boolean(isOnlineEnabled);
    }
    if (isCodEnabled !== undefined) {
      settings.isCodEnabled = Boolean(isCodEnabled);
    }

    if (req.admin) {
      settings.updatedBy = req.admin._id;
    }

    await settings.save();

    return res.status(200).json({
      success: true,
      message: "Payment settings updated successfully",
      data: {
        isOnlineEnabled: settings.isOnlineEnabled,
        isCodEnabled: settings.isCodEnabled,
        allowedPaymentMethods: [
          ...(settings.isOnlineEnabled ? ["ONLINE"] : []),
          ...(settings.isCodEnabled ? ["COD"] : []),
        ],
        updatedAt: settings.updatedAt,
      },
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: err.message,
    });
  }
};

exports.payCOD = async (req, res) => {
  try {
    const parentId = req.parent._id;
    const { invoiceId } = req.params;
    const { remarks = "" } = req.body;

    const settings = await getOrCreatePaymentSettings();
    if (!settings.isCodEnabled) {
      return res.status(400).json({
        success: false,
        message: "Cash on Delivery (COD) payment method is currently disabled by Admin.",
      });
    }

    const invoice = await Invoice.findById(invoiceId);
    if (!invoice) {
      return res.status(404).json({
        success: false,
        message: "Invoice not found",
      });
    }

    if (invoice.parent.toString() !== parentId.toString()) {
      return res.status(403).json({
        success: false,
        message: "Unauthorized invoice access",
      });
    }

    if (invoice.paymentStatus === "PAID") {
      return res.status(400).json({
        success: false,
        message: "Invoice has already been paid",
      });
    }

    if (invoice.status !== "ACTIVE") {
      return res.status(400).json({ success: false, message: "Cannot pay a cancelled invoice" });
    }

    if (invoice.paymentStatus === "PAYMENT_PENDING" || await Payment.exists({ invoice: invoice._id, status: "PENDING" })) {
      return res.status(409).json({ success: false, message: "A payment verification is already pending for this invoice" });
    }

    const payment = await createPendingInvoicePayment({
      invoiceId: invoice._id,
      parentId,
      paymentMethod: "COD",
      remarks: remarks || "Parent selected Cash on Delivery (COD)",
    });

    try {
      await sendNotification({
        recipientType: "ADMIN",
        adminId: null,
        title: "COD Payment Submitted 💵",
        message: `Parent submitted Cash on Delivery payment request for Invoice #${invoice.invoiceNumber}. Pending approval.`,
        type: "PAYMENT_SUBMITTED",
        data: {
          invoiceId: String(invoice._id),
          paymentId: String(payment._id),
          parentId: String(parentId),
        },
      });
    } catch (notifErr) {
      console.error("Notification error:", notifErr.message);
    }

    return res.status(201).json({
      success: true,
      message: "COD payment option selected. Awaiting admin verification.",
      data: payment,
    });
  } catch (err) {
    return res.status(err.status || 500).json({
      success: false,
      message: err.message,
    });
  }
};

exports.payOnline = async (req, res) => {
  try {
    const parentId = req.parent._id;
    const { invoiceId } = req.params;
    const { transactionId, remarks = "" } = req.body;

    const settings = await getOrCreatePaymentSettings();
    if (!settings.isOnlineEnabled) {
      return res.status(400).json({
        success: false,
        message: "Online payment method is currently disabled by Admin.",
      });
    }

    const invoice = await Invoice.findOne({ _id: invoiceId, parent: parentId });
    if (!invoice) {
      return res.status(404).json({
        success: false,
        message: "Invoice not found or unauthorized",
      });
    }

    if (invoice.status === "CANCELLED") {
      return res.status(400).json({
        success: false,
        message: "Cannot pay a cancelled invoice",
      });
    }

    if (invoice.paymentStatus === "PAID") {
      return res.status(400).json({
        success: false,
        message: "Invoice is already paid",
      });
    }

    if (invoice.paymentStatus === "PAYMENT_PENDING") {
      return res.status(400).json({
        success: false,
        message: "A payment verification is already pending for this invoice",
      });
    }

    if (await Payment.exists({ invoice: invoice._id, status: "PENDING" })) {
      return res.status(409).json({ success: false, message: "A payment verification is already pending for this invoice" });
    }

    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: "paymentScreenshot file is required for online payment",
      });
    }

    if (!transactionId) {
      return res.status(400).json({
        success: false,
        message: "transactionId is required for online payment",
      });
    }

    const paymentScreenshot = `uploads/payment-screenshots/${req.file.filename}`;

    const payment = await createPendingInvoicePayment({
      invoiceId: invoice._id,
      parentId,
      paymentMethod: "ONLINE",
      transactionId,
      paymentScreenshot,
      remarks,
    });

    try {
      await sendNotification({
        recipientType: "ADMIN",
        adminId: null,
        title: "Payment Proof Submitted 📤",
        message: `Online payment proof for Invoice #${invoice.invoiceNumber} has been uploaded. Pending admin verification.`,
        type: "PAYMENT_SUBMITTED",
        data: {
          invoiceId: String(invoice._id),
          paymentId: String(payment._id),
          parentId: String(parentId),
        },
      });
    } catch (notifErr) {
      console.error("Notification error:", notifErr.message);
    }

    return res.status(201).json({
      success: true,
      message: "Online payment screenshot submitted successfully. Pending admin verification.",
      data: payment,
    });
  } catch (err) {
    return res.status(err.status || 500).json({
      success: false,
      message: err.message,
    });
  }
};

exports.resubmitPayment = async (req, res) => {
  try {
    const parentId = req.parent._id;
    const { paymentId } = req.params;
    const { transactionId, remarks } = req.body;

    const payment = await Payment.findOne({ _id: paymentId, parent: parentId });
    if (!payment) {
      return res.status(404).json({
        success: false,
        message: "Payment record not found or unauthorized",
      });
    }

    if (payment.status !== "REJECTED") {
      return res.status(400).json({
        success: false,
        message: "Only rejected payments can be resubmitted",
      });
    }

    if (await Payment.exists({ invoice: payment.invoice, status: "PENDING", _id: { $ne: payment._id } })) {
      return res.status(409).json({ success: false, message: "Another payment is already pending for this invoice" });
    }

    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: "New paymentScreenshot file is required for resubmission",
      });
    }

    const newScreenshot = `uploads/payment-screenshots/${req.file.filename}`;

    payment.paymentScreenshot = newScreenshot;
    if (transactionId) payment.transactionId = transactionId;
    if (remarks) payment.remarks = remarks;
    payment.status = "PENDING";
    payment.rejectionReason = "";
    await payment.save();

    const invoice = await Invoice.findById(payment.invoice);
    if (invoice) {
      invoice.paymentStatus = "PAYMENT_PENDING";
      await invoice.save();
    }

    return res.status(200).json({
      success: true,
      message: "Payment resubmitted successfully. Pending admin verification.",
      data: payment,
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: err.message,
    });
  }
};

exports.getParentPayments = async (req, res) => {
  try {
    const parentId = req.parent._id;
    const { page = 1, limit = 10 } = req.query;

    const currentPage = Math.max(1, parseInt(page, 10) || 1);
    const pageLimit = Math.max(1, parseInt(limit, 10) || 10);
    const skip = (currentPage - 1) * pageLimit;

    const [payments, total, bankDetails] = await Promise.all([
      Payment.find({ parent: parentId })
        .populate(
          "invoice",
          "invoiceNumber totalAmount items paymentStatus dueDate"
        )
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(pageLimit),

      Payment.countDocuments({ parent: parentId }),

      BankDetails.findOne({ isActive: true }),
    ]);

    const data = payments.map((payment) => {
      const paymentObj = payment.toObject();

      if (paymentObj.status === "REJECTED") {
        paymentObj.bankDetails = bankDetails;
      }

      return paymentObj;
    });

    return res.status(200).json({
      success: true,
      count: data.length,
      pagination: {
        page: currentPage,
        limit: pageLimit,
        total,
        pages: Math.ceil(total / pageLimit),
      },
      data,
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: err.message,
    });
  }
};

exports.getAdminPayments = async (req, res) => {
  try {
    const {
      status,
      paymentMethod,
      method,
      parent,
      invoice,
      search,
      startDate,
      endDate,
      page = 1,
      limit = 10,
    } = req.query;

    const query = {};
    if (req.staffScope?.scope === "ASSIGNED") {
      const ids = await require("../middleware/isAdmin").assignedPlayerIds(req.admin._id);
      const invoiceIds = await Invoice.find(require("../middleware/isAdmin").assignedInvoiceQuery(ids)).distinct("_id");
      query.invoice = { $in: invoiceIds };
    }

    if (status) query.status = status;
    const activeMethod = paymentMethod || method;
    if (activeMethod) query.paymentMethod = activeMethod;
    if (parent) query.parent = parent;
    if (invoice) {
      if (req.staffScope?.scope === "ASSIGNED") query.$and = [...(query.$and || []), { invoice }];
      else query.invoice = invoice;
    }

    if (startDate || endDate) {
      query.createdAt = {};
      if (startDate) query.createdAt.$gte = new Date(startDate);
      if (endDate) query.createdAt.$lte = new Date(endDate);
    }

    if (search) {
      const searchRegex = new RegExp(search, "i");

      const [matchingParents, matchingInvoices] = await Promise.all([
        Parent.find({
          $or: [{ fullName: searchRegex }, { email: searchRegex }, { phone: searchRegex }],
        }).select("_id"),
        Invoice.find({ invoiceNumber: searchRegex }).select("_id"),
      ]);

      const parentIds = matchingParents.map((p) => p._id);
      const invoiceIds = matchingInvoices.map((i) => i._id);

      query.$or = [
        { transactionId: searchRegex },
        { remarks: searchRegex },
        { parent: { $in: parentIds } },
        { invoice: { $in: invoiceIds } },
      ];
    }

    const currentPage = Math.max(1, parseInt(page, 10) || 1);
    const pageLimit = Math.max(1, parseInt(limit, 10) || 10);
    const skip = (currentPage - 1) * pageLimit;

    const [payments, total] = await Promise.all([
      Payment.find(query)
        .populate("parent", "fullName email phone")
        .populate({
          path: "invoice",
          populate: [
            { path: "players", select: "firstName lastName fullName" },
            { path: "class", select: "name price dayOfWeek startTime endTime venue location" },
          ],
        })
        .populate("approvedBy", "name email")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(pageLimit),
      Payment.countDocuments(query),
    ]);

    return res.status(200).json({
      success: true,
      count: payments.length,
      pagination: {
        page: currentPage,
        limit: pageLimit,
        total,
        pages: Math.ceil(total / pageLimit),
      },
      data: payments,
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: err.message,
    });
  }
};

exports.getAdminPaymentById = async (req, res) => {
  try {
    const { id } = req.params;

    const payment = await Payment.findById(id)
      .populate("parent", "fullName email phone emergencyContact relationship")
      .populate({
        path: "invoice",
        populate: [
          { path: "players", select: "firstName lastName fullName category assignedClasses" },
          { path: "parent", select: "fullName email phone" },
          { path: "class", select: "name price dayOfWeek startTime endTime venue location" },
        ],
      })
      .populate("approvedBy", "name email");

    if (!payment) {
      return res.status(404).json({
        success: false,
        message: "Payment record not found",
      });
    }

    return res.status(200).json({
      success: true,
      data: payment,
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: err.message,
    });
  }
};

exports.recordAdminInvoicePayment = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const invoice = await Invoice.findById(req.params.id).session(session);
    if (!invoice) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: "Invoice not found" });
    }
    const result = await recordAdminPaymentForInvoice(invoice, req.admin?._id, session);
    await session.commitTransaction();
    if (broadcastSidebarBadges) broadcastSidebarBadges().catch(() => {});
    return res.status(200).json({
      success: true,
      message: result.alreadyPaid ? "Invoice is already settled; no duplicate payment was recorded." : "Payment recorded and approved; invoice and related statuses were updated.",
      data: { invoiceId: invoice._id, payment: result.payment, alreadyPaid: result.alreadyPaid, zeroAmount: result.zeroAmount },
    });
  } catch (err) {
    await session.abortTransaction();
    return res.status(err.status || 500).json({ success: false, message: err.message });
  } finally {
    await session.endSession();
  }
};

exports.approvePayment = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { id } = req.params;

    const payment = await Payment.findById(id).session(session);
    if (!payment) {
      await session.abortTransaction();
      session.endSession();
      return res.status(404).json({
        success: false,
        message: "Payment record not found",
      });
    }

    if (payment.status !== "PENDING") {
      await session.abortTransaction();
      session.endSession();
      return res.status(409).json({
        success: false,
        message: payment.status === "APPROVED" ? "Payment is already approved" : "Only pending payments can be approved",
      });
    }

    const invoice = await Invoice.findById(payment.invoice).session(session);
    if (!invoice) {
      await session.abortTransaction();
      session.endSession();
      return res.status(404).json({
        success: false,
        message: "Associated invoice not found",
      });
    }

    if (invoice.status !== "ACTIVE") {
      await session.abortTransaction();
      session.endSession();
      return res.status(409).json({ success: false, message: "Cannot approve a payment for a cancelled invoice" });
    }

    const approvedRows = await Payment.aggregate([
      { $match: { invoice: invoice._id, status: "APPROVED" } },
      { $group: { _id: null, total: { $sum: "$amount" } } },
    ]).session(session);
    const alreadyReceived = Number(approvedRows[0]?.total || 0);
    const invoiceTotal = Math.max(0, Number(invoice.totalAmount ?? invoice.amount) || 0);
    const remaining = Math.max(0, Math.round((invoiceTotal - alreadyReceived) * 100) / 100);
    if (remaining <= 0 || Math.abs(Number(payment.amount) - remaining) > 0.009) {
      await session.abortTransaction();
      session.endSession();
      return res.status(409).json({
        success: false,
        message: remaining <= 0
          ? "This invoice is already fully paid by another transaction. The duplicate payment was not approved."
          : `Payment amount must equal the remaining invoice balance of ${remaining.toFixed(2)}.`,
      });
    }

    payment.status = "APPROVED";
    payment.approvedBy = req.admin ? req.admin._id : null;
    payment.approvedAt = new Date();
    await payment.save({ session });

    invoice.paymentStatus = "PAID";
    invoice.verifiedBy = req.admin ? req.admin._id : null;
    invoice.verifiedAt = new Date();
    await invoice.save({ session });
    await syncPaidInvoiceEffects(invoice, session);

    await session.commitTransaction();
    session.endSession();

    try {
      await sendNotification({
        recipientType: "PARENT",
        parentId: payment.parent,
        title: "Payment Approved 🎉",
        message: `Your payment of ${payment.amount} for Invoice #${invoice.invoiceNumber} has been verified & approved.`,
        type: "PAYMENT_APPROVED",
        data: {
          parentId: String(payment.parent),
          paymentId: String(payment._id),
          invoiceId: String(invoice._id),
          invoiceNumber: String(invoice.invoiceNumber),
          amount: String(payment.amount),
        },
      });
    } catch (notifErr) {
      console.error("Notification error:", notifErr.message);
    }

    if (broadcastSidebarBadges) {
      broadcastSidebarBadges().catch(() => {});
    }

    return res.status(200).json({
      success: true,
      message: "Payment approved successfully. Invoice and player status updated.",
      data: payment,
    });
  } catch (err) {
    await session.abortTransaction();
    session.endSession();
    return res.status(500).json({
      success: false,
      message: err.message,
    });
  }
};

exports.rejectPayment = async (req, res) => {
  try {
    const { id } = req.params;
    const { reason = "Payment proof invalid" } = req.body;

    const session = await mongoose.startSession();
    session.startTransaction();
    let payment;
    let invoice;
    try {
      payment = await Payment.findById(id).session(session);
      if (!payment) {
        await session.abortTransaction();
        return res.status(404).json({ success: false, message: "Payment record not found" });
      }

      if (payment.status !== "PENDING") {
        await session.abortTransaction();
        return res.status(400).json({
          success: false,
          message: payment.status === "APPROVED" ? "Cannot reject an already approved payment" : "Only pending payments can be rejected",
        });
      }

      payment.status = "REJECTED";
      payment.rejectionReason = reason;
      await payment.save({ session });

      invoice = await Invoice.findById(payment.invoice).session(session);
      if (invoice) {
        const approvedRows = await Payment.aggregate([
          { $match: { invoice: invoice._id, status: "APPROVED" } },
          { $group: { _id: null, total: { $sum: "$amount" } } },
        ]).session(session);
        const approvedTotal = Number(approvedRows[0]?.total || 0);
        const invoiceTotal = Math.max(0, Number(invoice.totalAmount ?? invoice.amount) || 0);
        const otherPending = await Payment.exists({ invoice: invoice._id, status: "PENDING" }).session(session);
        invoice.paymentStatus = invoiceTotal <= 0 || approvedTotal >= invoiceTotal - 0.009
          ? "PAID"
          : otherPending ? "PAYMENT_PENDING" : "UNPAID";
        await invoice.save({ session });
        if (invoice.paymentStatus === "PAID") await syncPaidInvoiceEffects(invoice, session);
      }
      await session.commitTransaction();
    } catch (transactionError) {
      await session.abortTransaction();
      throw transactionError;
    } finally {
      await session.endSession();
    }

    try {
      await sendNotification({
        recipientType: "PARENT",
        parentId: payment.parent,
        title: "Payment Rejected ❌",
        message: `Your payment proof for Invoice #${invoice ? invoice.invoiceNumber : ""} was rejected. Reason: ${reason}. Please resubmit payment.`,
        type: "PAYMENT_REJECTED",
        data: {
          parentId: String(payment.parent),
          paymentId: String(payment._id),
          invoiceId: invoice ? String(invoice._id) : "",
          invoiceNumber: invoice ? String(invoice.invoiceNumber) : "",
          reason,
        },
      });
    } catch (notifErr) {
      console.error("Notification error:", notifErr.message);
    }

    if (broadcastSidebarBadges) {
      broadcastSidebarBadges().catch(() => {});
    }

    return res.status(200).json({
      success: true,
      message: "Payment rejected successfully. Parent can resubmit payment proof.",
      data: payment,
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: err.message,
    });
  }
};
exports.getPaymentDashboardStats = async (req, res) => {
  try {
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);

    const [
      activeInvoices,
      approvedByInvoiceRows,
      pendingPayments,
      rejectedPayments,
      todaysPayments,
      monthlyPayments,
      storeSalesReceipts,
    ] = await Promise.all([
      Invoice.find({ status: "ACTIVE" }).select("_id totalAmount amount type").lean(),
      Payment.aggregate([
        { $match: { status: "APPROVED" } },
        { $group: { _id: "$invoice", total: { $sum: "$amount" } } },
      ]),
      Payment.countDocuments({ status: "PENDING" }),
      Payment.countDocuments({ status: "REJECTED" }),
      Payment.aggregate([
        { $match: { status: "APPROVED", approvedAt: { $gte: startOfToday } } },
        { $group: { _id: null, total: { $sum: "$amount" } } },
      ]),
      Payment.aggregate([
        { $match: { status: "APPROVED", approvedAt: { $gte: startOfMonth } } },
        { $group: { _id: null, total: { $sum: "$amount" } } },
      ]),
      Payment.aggregate([
        { $match: { status: "APPROVED" } },
        { $lookup: { from: Invoice.collection.name, localField: "invoice", foreignField: "_id", as: "invoice" } },
        { $unwind: "$invoice" },
        { $match: { "invoice.status": "ACTIVE", "invoice.type": "STORE_ORDER" } },
        { $group: { _id: null, total: { $sum: "$amount" } } },
      ]),
    ]);

    const approvedByInvoice = new Map(approvedByInvoiceRows.map((row) => [String(row._id), Number(row.total) || 0]));
    const paidInvoices = activeInvoices.filter((invoice) => {
      const due = Math.max(0, Number(invoice.totalAmount ?? invoice.amount) || 0);
      return due === 0 || (approvedByInvoice.get(String(invoice._id)) || 0) >= due - 0.009;
    }).length;
    const totalInvoices = activeInvoices.length;
    const pendingInvoices = Math.max(0, totalInvoices - paidInvoices);
    const outstandingAmount = activeInvoices.reduce((sum, invoice) => {
      const due = Math.max(0, Number(invoice.totalAmount ?? invoice.amount) || 0);
      return sum + Math.max(0, due - (approvedByInvoice.get(String(invoice._id)) || 0));
    }, 0);

    const stats = {
      totalInvoices,
      pendingInvoices,
      paidInvoices,
      pendingPayments,
      rejectedPayments,
      todaysCollections: todaysPayments.length > 0 ? todaysPayments[0].total : 0,
      monthlyCollections: monthlyPayments.length > 0 ? monthlyPayments[0].total : 0,
      storeSales: storeSalesReceipts.length > 0 ? storeSalesReceipts[0].total : 0,
      outstandingAmount,
    };

    return res.status(200).json({
      success: true,
      data: stats,
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: err.message,
    });
  }
};
