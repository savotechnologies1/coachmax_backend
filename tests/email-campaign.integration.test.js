const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const EmailCampaign = require("../models/EmailCampaign");
const EmailCampaignRecipient = require("../models/EmailCampaignRecipient");
const Notification = require("../models/Notification");
const { queueEmail, processDeliveryJobs } = require("../services/deliveryService");

let database;

test.before(async () => {
  mongoose.set("autoIndex", false);
  database = await MongoMemoryServer.create();
  await mongoose.connect(database.getUri(), { dbName: "email_campaign_test" });
}, { timeout: 120000 });

test.after(async () => {
  await mongoose.disconnect();
  if (database) await database.stop();
});

test("campaigns queue and update recipient delivery without new collections or notification leaks", async () => {
  const [campaign] = await EmailCampaign.create([{
    createdBy: new mongoose.Types.ObjectId(),
    audienceType: "CLASS",
    audienceId: new mongoose.Types.ObjectId(),
    audienceName: "Test class",
    subject: "Schedule update",
    message: "The session begins at 4 pm.",
    selectedPlayerCount: 1,
  }]);
  const [recipient] = await EmailCampaignRecipient.insertMany([{
    campaign: campaign._id,
    recipientEmail: "guardian@example.invalid",
    status: "QUEUED",
  }]);
  await queueEmail(`campaign:${campaign._id}:${recipient._id}`, {
    to: recipient.recipientEmail,
    subject: campaign.subject,
    html: "<p>Schedule update</p>",
    campaignRecipientId: String(recipient._id),
  });

  const collections = (await mongoose.connection.db.listCollections().toArray()).map((item) => item.name);
  assert.ok(collections.includes("notifications"));
  assert.ok(!collections.includes("emailcampaigns"));
  assert.ok(!collections.includes("emailcampaignrecipients"));
  assert.equal(await EmailCampaign.countDocuments(), 1);
  assert.equal(await EmailCampaignRecipient.countDocuments(), 1);
  assert.equal(await Notification.countDocuments(), 0);
  assert.equal(await Notification.findById(campaign._id), null);
  assert.equal((await EmailCampaignRecipient.aggregate([{ $group: { _id: "$status", count: { $sum: 1 } } }]))[0].count, 1);

  let accepted = 0;
  await processDeliveryJobs({ sendEmailFn: async () => { accepted += 1; return true; } });
  assert.equal(accepted, 1);
  assert.equal((await EmailCampaignRecipient.findById(recipient._id)).status, "SENT");
  assert.equal((await Notification.collection.findOne({ "deliveryPayload.campaignRecipientId": String(recipient._id) })).deliveryStatus, "SENT");
});
