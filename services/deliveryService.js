const Notification = require("../models/Notification");
const EmailCampaignRecipient = require("../models/EmailCampaignRecipient");
const { sendNotification } = require("./notificationService");
const sendEmail = require("../utils/sendEmail");
const sendEmailStrict = sendEmail.sendEmailStrict || sendEmail;
const queueNotification = (key, payload, session) => {
  const recipientType = payload.recipientType || (payload.adminId || payload.coachId ? "ADMIN" : "PARENT");
  const parent = recipientType === "PARENT" ? payload.parentId || payload.userId || null : null;
  const admin = ["ADMIN", "COACH"].includes(recipientType) ? payload.adminId || payload.coachId || payload.userId || null : null;
  const now = new Date();
  return Notification.updateOne({ idempotencyKey: key }, { $setOnInsert: {
    idempotencyKey: key,
    recipientType,
    parent,
    admin,
    title: payload.title || "Notification",
    message: payload.message || "",
    type: payload.type || "ANNOUNCEMENT",
    data: payload.data || {},
    isRead: false,
    isDeliveryOnly: false,
    deliveryKind: "NOTIFICATION",
    deliveryPayload: payload,
    deliveryStatus: "PENDING",
    deliveryAttempts: 0,
    deliveryNextAttempt: now,
  } }, { upsert: true, session });
};
const queueEmail = (key, payload, session) => Notification.updateOne({ idempotencyKey: `email:${key}` }, { $setOnInsert: {
  idempotencyKey: `email:${key}`,
  recipientType: "ADMIN",
  title: payload.subject || "Email delivery",
  message: payload.text || payload.subject || "Email delivery",
  type: "GENERAL",
  isRead: true,
  isDeliveryOnly: true,
  deliveryKind: "EMAIL",
  deliveryPayload: payload,
  deliveryStatus: "PENDING",
  deliveryAttempts: 0,
  deliveryNextAttempt: new Date(),
} }, { upsert: true, session });
const deliveryErrorCode = (error) => {
  const code = String(error?.code || "EMAIL_DELIVERY_FAILED");
  return /^[A-Z0-9_]{2,48}$/.test(code) ? code : "EMAIL_DELIVERY_FAILED";
};

const claimDeliveryJob = async (filter) => {
  const now = new Date();
  const result = await Notification.collection.findOneAndUpdate({
    ...filter,
    deliveryKind: { $in: ["NOTIFICATION", "EMAIL"] },
    $or: [
      { deliveryStatus: "PENDING", deliveryNextAttempt: { $lte: now } },
      { deliveryStatus: "SENDING", deliveryLockedUntil: { $lt: now } },
    ],
  }, { $set: { deliveryStatus: "SENDING", deliveryLockedUntil: new Date(Date.now() + 60000) }, $inc: { deliveryAttempts: 1 } }, { returnDocument: "after", sort: { deliveryNextAttempt: 1 } });
  return result && Object.prototype.hasOwnProperty.call(result, "value") ? result.value : result;
};

const deliverClaimedJob = async (notification, { sendEmailFn = sendEmailStrict, sendNotificationFn = sendNotification } = {}) => {
  const attempts = notification.deliveryAttempts;
  const emailPayload = notification.deliveryKind === "EMAIL" ? notification.deliveryPayload || {} : null;
  if (emailPayload?.campaignRecipientId) {
    await EmailCampaignRecipient.updateOne({ _id: emailPayload.campaignRecipientId }, { $set: { status: "SENDING", startedAt: new Date(), nextAttemptAt: null }, $inc: { attempts: 1 } }).catch(() => {});
  }
  try {
    if (notification.deliveryKind === "EMAIL") {
      if (!await sendEmailFn(emailPayload.to, emailPayload.subject, emailPayload.html)) {
        throw Object.assign(new Error("Email was not accepted for delivery"), { code: "EMAIL_NOT_ACCEPTED" });
      }
    } else {
      await sendNotificationFn({ ...notification.deliveryPayload, idempotencyKey: notification.idempotencyKey, awaitPush: true });
    }
    await Notification.collection.updateOne({ _id: notification._id, deliveryAttempts: attempts }, { $set: { deliveryStatus: "SENT" }, $unset: { deliveryLockedUntil: 1, deliveryLastError: 1 } });
    if (emailPayload?.campaignRecipientId) {
      await EmailCampaignRecipient.updateOne({ _id: emailPayload.campaignRecipientId }, { $set: { status: "SENT", sentAt: new Date(), nextAttemptAt: null, lastError: "" } }).catch(() => {});
    }
    return { status: "SENT", attempts };
  } catch (error) {
    const code = deliveryErrorCode(error);
    const nextAttemptAt = new Date(Date.now() + Math.min(3600000, 30000 * 2 ** attempts));
    await Notification.collection.updateOne({ _id: notification._id, deliveryAttempts: attempts }, { $set: { deliveryStatus: attempts >= 8 ? "FAILED" : "PENDING", deliveryNextAttempt: nextAttemptAt, deliveryLastError: code }, $unset: { deliveryLockedUntil: 1 } });
    if (emailPayload?.campaignRecipientId) {
      await EmailCampaignRecipient.updateOne({ _id: emailPayload.campaignRecipientId }, { $set: {
        status: attempts >= 8 ? "FAILED" : "QUEUED",
        nextAttemptAt: attempts >= 8 ? null : nextAttemptAt,
        lastError: code,
      } }).catch(() => {});
    }
    return { status: attempts >= 8 ? "FAILED" : "PENDING", attempts, errorCode: code };
  }
};

async function processDeliveryJobById(id, options = {}) {
  const notification = await claimDeliveryJob({ _id: id });
  if (notification) return deliverClaimedJob(notification, options);
  const existing = await Notification.collection.findOne({ _id: id }, { projection: { deliveryStatus: 1, deliveryAttempts: 1, deliveryLastError: 1 } });
  if (!existing) return { status: "MISSING", attempts: 0 };
  return { status: existing.deliveryStatus || "PENDING", attempts: existing.deliveryAttempts || 0, errorCode: existing.deliveryLastError || undefined };
}

async function processDeliveryJobs(options = {}) {
  for (let count = 0; count < 50; count++) {
    const notification = await claimDeliveryJob({});
    if (!notification) break;
    await deliverClaimedJob(notification, options);
  }
}
module.exports = { queueNotification, queueEmail, processDeliveryJobById, processDeliveryJobs };
