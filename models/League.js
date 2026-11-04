const { dateOnly } = require("../utils/dateTime");
const mongoose = require("mongoose");

const leagueSchema = new mongoose.Schema(
  {
    schedulingRevision: { type: Number, default: 0 },
    archivedAt: { type: Date, default: null },
    venue: { type: String, default: "" },
    name: {
      type: String,
      required: true,
    },
    season: {
      type: String,
      required: true,
    },
    year: { type: Number, min: 1000, max: 9999 },
    termScope: {
      type: String,
      enum: ["TERM", "INDEPENDENT"],
      default: "TERM",
    },
    logo: {
      type: String,
      default: "",
    },
    description: {
      type: String,
      default: "",
    },
    startDate: {
      type: Date,
      required: true,
    },
    endDate: {
      type: Date,
      required: true,
    },
    status: {
      type: String,
      enum: ["UPCOMING", "ACTIVE", "COMPLETED", "DRAFT"],
      default: "ACTIVE",
    },
    type: {
      type: String,
      enum: ["INTERNATIONAL", "NATIONAL", "STATE", "LOCAL", "OTHERS"],
      default: "LOCAL",
    },
    term: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Term",
      default: null,
    },
    registrationStartDate: {
      type: Date,
      default: null,
    },
    registrationEndDate: {
      type: Date,
      default: null,
    },
    visibility: {
      type: String,
      enum: ["PUBLIC", "PRIVATE"],
      default: "PUBLIC",
    },
    pointsForWin: {
      type: Number,
      default: 3,
    },
    pointsForDraw: {
      type: Number,
      default: 1,
    },
    allowDraws: {
      type: Boolean,
      default: true,
    },
    automaticLadderRecalculation: {
      type: Boolean,
      default: true,
    },
    teams: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Team",
      },
    ],
    fixtureFormat: {
      type: String,
      enum: ["ROUND_ROBIN", "GROUP", "KNOCKOUT"],
      default: "ROUND_ROBIN",
    },
    groupCount: {
      type: Number,
      default: 1,
      min: 1,
    },
    numberOfRounds: {
      type: Number,
      default: 1,
      min: 1,
    },
    fee: {
      type: Number,
      default: 0,
      min: 0,
    },
    sessionDates: [
      {
        type: Date,
      },
    ],
    matchDuration: {
      type: Number,
      default: 90,
      min: 1,
    },
    breakBetweenMatches: {
      type: Number,
      default: 15,
      min: 0,
    },
    numberOfFields: {
      type: Number,
      default: 1,
      min: 1,
    },
    startTime: {
      type: String,
      default: "10:00",
    },
    fixtureGenerated: {
      type: Boolean,
      default: false,
    },
    generationType: {
      type: String,
      enum: ["AUTOMATIC", "MANUAL"],
      default: "MANUAL",
    },
    groups: [
      {
        name: {
          type: String,
          required: true,
        },
        teams: [
          {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Team",
          },
        ],
      },
    ],
  },
  { timestamps: true }
);

leagueSchema.set("toJSON", { transform: (_doc, result) => {
  result.termScope = result.term ? "TERM" : "INDEPENDENT";
  result.year ||= result.term?.year || (result.startDate ? new Date(result.startDate).getUTCFullYear() : undefined);
  if (result.startDate) result.startDate = dateOnly(result.startDate);
  if (result.endDate) result.endDate = dateOnly(result.endDate);
  if (result.registrationStartDate) result.registrationStartDate = dateOnly(result.registrationStartDate);
  if (result.registrationEndDate) result.registrationEndDate = dateOnly(result.registrationEndDate);
  if (result.sessionDates) result.sessionDates = result.sessionDates.map((date) => dateOnly(date));
  return result;
} });
leagueSchema.pre("validate", function () {
  if (this.termScope === "TERM" && !this.term) this.invalidate("term", "An academic term is required for a term-linked tournament.");
  if (this.termScope === "INDEPENDENT" && this.term) this.invalidate("term", "Independent tournaments cannot have an academic term.");
  if (this.termScope === "INDEPENDENT" && !this.year) this.invalidate("year", "A year is required for an independent tournament.");
});
leagueSchema.index({ term: 1, name: 1 });
leagueSchema.index({ termScope: 1, year: 1, archivedAt: 1 });
module.exports = mongoose.model("League", leagueSchema);
