const mongoose = require("mongoose");

const emailCampaignSchema = new mongoose.Schema({
  emailRecordType: { type: String, default: "CAMPAIGN", immutable: true },
  isDeliveryOnly: { type: Boolean, default: true, immutable: true },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "Admin", required: true, index: true },
  audienceType: { type: String, enum: ["CLASS", "EVENT", "TOURNAMENT"], required: true, index: true },
  audienceId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  audienceName: { type: String, required: true },
  subject: { type: String, required: true, maxlength: 180 },
  message: { type: String, required: true, maxlength: 12000 },
  selectedPlayerCount: { type: Number, default: 0 },
}, { timestamps: true, collection: "notifications" });

emailCampaignSchema.index({ createdAt: -1 });

// Email campaign records share the existing notifications collection because
// the database cannot create more collections. Always scope model queries so
// campaigns cannot be mistaken for notifications or recipient records.
emailCampaignSchema.pre(["find", "findOne", "countDocuments", "updateOne", "updateMany", "findOneAndUpdate", "deleteOne", "deleteMany"], function scopeCampaignQueries() {
  this.where({ emailRecordType: "CAMPAIGN" });
});
emailCampaignSchema.pre("aggregate", function scopeCampaignAggregates() {
  this.pipeline().unshift({ $match: { emailRecordType: "CAMPAIGN" } });
});

module.exports = mongoose.model("EmailCampaign", emailCampaignSchema);
