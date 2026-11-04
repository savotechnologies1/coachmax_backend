const mongoose = require("mongoose");

const emailCampaignRecipientSchema = new mongoose.Schema({
  emailRecordType: { type: String, default: "RECIPIENT", immutable: true },
  isDeliveryOnly: { type: Boolean, default: true, immutable: true },
  campaign: { type: mongoose.Schema.Types.ObjectId, ref: "EmailCampaign", required: true, index: true },
  playerIds: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
  playerNames: [{ type: String }],
  recipientName: { type: String, default: "Parent/Guardian" },
  recipientEmail: { type: String, default: "", lowercase: true, trim: true },
  status: { type: String, enum: ["QUEUED", "SENDING", "SENT", "FAILED", "SKIPPED"], required: true, index: true },
  skipReason: { type: String, default: "" },
  attempts: { type: Number, default: 0 },
  queuedAt: { type: Date, default: null },
  startedAt: { type: Date, default: null },
  sentAt: { type: Date, default: null },
  nextAttemptAt: { type: Date, default: null },
  lastError: { type: String, default: "" },
}, { timestamps: true, collection: "notifications" });

emailCampaignRecipientSchema.index({ campaign: 1, createdAt: -1 });
emailCampaignRecipientSchema.index({ campaign: 1, status: 1 });

emailCampaignRecipientSchema.pre(["find", "findOne", "countDocuments", "updateOne", "updateMany", "findOneAndUpdate", "deleteOne", "deleteMany"], function scopeRecipientQueries() {
  this.where({ emailRecordType: "RECIPIENT" });
});
emailCampaignRecipientSchema.pre("aggregate", function scopeRecipientAggregates() {
  this.pipeline().unshift({ $match: { emailRecordType: "RECIPIENT" } });
});

module.exports = mongoose.model("EmailCampaignRecipient", emailCampaignRecipientSchema);
