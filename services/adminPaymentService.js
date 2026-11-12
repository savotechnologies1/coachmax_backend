const Payment = require("../models/Payment");
const Invoice = require("../models/Invoice");
const User = require("../models/User");
const Order = require("../models/Order");

const withSession = (query, session) => session ? query.session(session) : query;

async function syncPaidInvoiceEffects(invoice, session) {
  const players = Array.isArray(invoice.players) ? invoice.players : [];

  if (invoice.class && players.length) {
    const classId = String(invoice.class._id || invoice.class);
    const users = await withSession(User.find({ _id: { $in: players } }), session);
    for (const user of users) {
      user.classPaymentStatuses = user.classPaymentStatuses || [];
      const status = user.classPaymentStatuses.find((entry) => String(entry.class?._id || entry.class) === classId);
      if (status) status.paymentStatus = "PAID";
      else user.classPaymentStatuses.push({ class: invoice.class, paymentStatus: "PAID" });
      const statuses = user.classPaymentStatuses.map((entry) => String(entry.paymentStatus || "UNPAID").toUpperCase());
      if (statuses.some((value) => value === "OVER_DUE")) user.paymentStatus = "OVER_DUE";
      else if (statuses.some((value) => value === "UNPAID")) user.paymentStatus = "UNPAID";
      else if (statuses.length && statuses.every((value) => value === "PAID")) user.paymentStatus = "PAID";
      else if (statuses.some((value) => value === "TRIAL")) user.paymentStatus = "TRIAL";
      await user.save(session ? { session } : undefined);
    }
  }

  if (invoice.team && players.length) {
    const Team = require("../models/Team");
    const team = await withSession(Team.findById(invoice.team), session);
    if (team) {
      const targetList = invoice.league
        ? team.leagues?.find((entry) => String(entry.league?._id || entry.league) === String(invoice.league._id || invoice.league))?.players
        : team.players;
      if (Array.isArray(targetList)) {
        for (const playerId of players) {
          let entry = targetList.find((item) => String(item.player?._id || item.player || item) === String(playerId));
          if (entry && entry.player) entry.paymentStatus = "PAID";
          else if (!entry) targetList.push({ player: playerId, paymentStatus: "PAID", status: "ACTIVE" });
        }
        team.markModified(invoice.league ? "leagues" : "players");
        await team.save(session ? { session } : undefined);
      }
    }
  }

  if (invoice.type === "STORE_ORDER") {
    await Order.updateMany({ invoice: invoice._id }, { paymentStatus: "PAID" }, session ? { session } : {});
  }

  if (invoice.event || invoice.eventRegistration || invoice.type === "CAMP_FEE" || invoice.type === "TOURNAMENT_FEE") {
    const EventRegistration = require("../models/EventRegistration");
    const filter = invoice.eventRegistration ? { _id: invoice.eventRegistration } : { invoice: invoice._id };
    const registrations = await withSession(EventRegistration.find(filter), session);
    for (const registration of registrations) {
      if (registration.status !== "REGISTERED") continue;
      const relatedInvoices = await withSession(Invoice.find({
        $or: [{ eventRegistration: registration._id }, { _id: registration.invoice }],
        status: "ACTIVE",
        totalAmount: { $gt: 0 },
      }).select("totalAmount amount"), session);
      const invoiceIds = relatedInvoices.map((item) => item._id);
      const approvedRows = invoiceIds.length ? await Payment.aggregate([
        { $match: { invoice: { $in: invoiceIds }, status: "APPROVED" } },
        { $group: { _id: "$invoice", total: { $sum: "$amount" } } },
      ]).session(session) : [];
      const approvedByInvoice = new Map(approvedRows.map((row) => [String(row._id), Number(row.total) || 0]));
      const outstanding = relatedInvoices.some((item) => {
        const due = Math.max(0, Number(item.totalAmount ?? item.amount) || 0);
        return (approvedByInvoice.get(String(item._id)) || 0) < due - 0.009;
      });
      registration.paymentStatus = outstanding ? "UNPAID" : "PAID";
      await registration.save(session ? { session } : undefined);
    }
  }
}

async function recordAdminPaymentForInvoice(invoice, adminId, session) {
  if (!invoice || invoice.status !== "ACTIVE") {
    throw Object.assign(new Error("An active invoice is required to record payment"), { status: 409 });
  }

  const total = Math.max(0, Number(invoice.totalAmount ?? invoice.amount) || 0);
  if (total === 0) {
    invoice.paymentStatus = "PAID";
    invoice.verifiedBy = adminId || undefined;
    invoice.verifiedAt = new Date();
    await invoice.save(session ? { session } : undefined);
    await syncPaidInvoiceEffects(invoice, session);
    return { payment: null, alreadyPaid: true, zeroAmount: true };
  }

  const payments = await withSession(Payment.find({ invoice: invoice._id }).sort({ createdAt: 1 }), session);
  const approvedTotal = payments
    .filter((payment) => payment.status === "APPROVED")
    .reduce((sum, payment) => sum + (Number(payment.amount) || 0), 0);
  const remaining = Math.max(0, Math.round((total - approvedTotal) * 100) / 100);

  if (remaining <= 0) {
    invoice.paymentStatus = "PAID";
    invoice.verifiedBy = invoice.verifiedBy || adminId || undefined;
    invoice.verifiedAt = invoice.verifiedAt || new Date();
    await invoice.save(session ? { session } : undefined);
    await syncPaidInvoiceEffects(invoice, session);
    return { payment: payments.find((payment) => payment.status === "APPROVED") || null, alreadyPaid: true, zeroAmount: false };
  }

  const pending = payments.filter((payment) => payment.status === "PENDING");
  if (pending.length > 1 || (pending.length === 1 && Math.abs(Number(pending[0].amount) - remaining) > 0.009)) {
    throw Object.assign(new Error("This invoice has a pending payment that does not match the remaining balance. Reconcile the transaction before marking it paid."), { status: 409 });
  }

  let payment;
  if (pending.length === 1) {
    payment = pending[0];
    payment.status = "APPROVED";
    payment.approvedBy = adminId || undefined;
    payment.approvedAt = new Date();
    payment.remarks = [payment.remarks, "Approved by admin while recording the invoice as paid."].filter(Boolean).join(" ");
  } else {
    if (!invoice.parent) {
      throw Object.assign(new Error("Invoice has no parent account; cannot record payment"), { status: 422 });
    }
    [payment] = await Payment.create([{
      invoice: invoice._id,
      parent: invoice.parent,
      amount: remaining,
      paymentMethod: "ADMIN_MANUAL",
      remarks: "Payment recorded as received by an administrator from the payment status screen.",
      status: "APPROVED",
      approvedBy: adminId || undefined,
      approvedAt: new Date(),
    }], session ? { session } : {});
  }

  invoice.paymentMethod = payment.paymentMethod;
  invoice.paymentStatus = "PAID";
  invoice.verifiedBy = adminId || undefined;
  invoice.verifiedAt = new Date();
  await payment.save(session ? { session } : undefined);
  await invoice.save(session ? { session } : undefined);
  await syncPaidInvoiceEffects(invoice, session);
  return { payment, alreadyPaid: false, zeroAmount: false };
}

module.exports = { recordAdminPaymentForInvoice, syncPaidInvoiceEffects };
