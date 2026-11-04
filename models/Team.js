const { dateOnly } = require("../utils/dateTime");
const mongoose = require("mongoose");
const teamTemporaryPlayerSchema = require("./TeamTemporaryPlayer");
const { normalizeTeamName } = require("../utils/leagueIntegrity");

const teamSchema = new mongoose.Schema(
  {
    teamName: {
      type: String,
      required: true,
    },
    normalizedName: { type: String, required: true },
    archivedAt: { type: Date, default: null },
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
    coach: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Admin",
    },
    assistantCoach: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Admin",
    },
    ageGroup: {
      type: String,
      default: "",
    },
    captain: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
    viceCaptain: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
    players: [
      {
        player: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "User",
        },
        paymentStatus: {
          type: String,
          enum: ["TRIAL", "UNPAID", "PAID", "OVER_DUE", "EXTRA", "SUBSTITUTE", "TBC", "HANDSHAKE"],
          default: "UNPAID",
        },
        statistics: {
          appearances: { type: Number, min: 0, default: 0 },
          goals: { type: Number, min: 0, default: 0 },
          assists: { type: Number, min: 0, default: 0 },
          cleanSheets: { type: Number, min: 0, default: 0 },
          yellowCards: { type: Number, min: 0, default: 0 },
          redCards: { type: Number, min: 0, default: 0 },
          minutesPlayed: { type: Number, min: 0, default: 0 },
        },
      },
    ],
    // Rival roster information is kept on the external team only. These entries
    // are not User records and must never flow through academy player assignment.
    externalPlayers: [
      {
        name: { type: String, required: true, trim: true, maxlength: 100 },
        jerseyNumber: { type: String, required: true, trim: true, maxlength: 10 },
        user: { type: String, trim: true, maxlength: 100, default: "" },
      },
    ],
    teamType: {
      type: String,
      enum: ["INTERNAL", "EXTERNAL"],
      default: "INTERNAL",
    },
    term: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Term",
      default: null,
    },
    startDate: { type: Date, default: null },
    endDate: { type: Date, default: null },
    dayOfWeek: {
      type: String,
    },
    round: { type: Number, min: 1 },
    sessionDates: [{ type: Date }],
    teamFee: { type: Number, min: 0, default: 0 },
    startTime: String,
    endTime: String,
    venue: String,
    location: String,
    scheduleType: {
      type: String,
      enum: ["SINGLE_DAY", "WEEKDAYS", "CUSTOM"],
      default: "SINGLE_DAY",
    },
    schedule: [
      {
        dayOfWeek: { type: String },
        startTime: { type: String },
        endTime: { type: String },
      },
    ],
    // Multiple leagues & per-league attendance sessions
    leagues: [
      {
        league: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "League",
          required: true,
        },
        teamFee: {
          type: Number,
          default: 0,
          min: 0,
        },
        round: {
          type: Number,
          default: null,
        },
        sessionDates: [
          {
            type: Date,
          },
        ],
        group: {
          type: String,
          default: "",
        },
        status: {
          type: String,
          enum: ["ACTIVE", "COMPLETED", "WITHDRAWN"],
          default: "ACTIVE",
        },
        enrolledAt: {
          type: Date,
          default: Date.now,
        },
        players: [
          {
            player: {
              type: mongoose.Schema.Types.ObjectId,
              ref: "User",
            },
            paymentStatus: {
              type: String,
              enum: ["TRIAL", "UNPAID", "PAID", "OVER_DUE", "EXTRA", "SUBSTITUTE", "TBC", "HANDSHAKE"],
              default: "UNPAID",
            },
            status: {
              type: String,
              enum: ["ACTIVE", "INACTIVE", "SUSPENDED"],
              default: "ACTIVE",
            },
          },
        ],
        statistics: {
          played: { type: Number, default: 0 },
          won: { type: Number, default: 0 },
          drawn: { type: Number, default: 0 },
          lost: { type: Number, default: 0 },
          goalsFor: { type: Number, default: 0 },
          goalsAgainst: { type: Number, default: 0 },
          goalDifference: { type: Number, default: 0 },
          points: { type: Number, default: 0 },
        },
      },
    ],
    temporaryPlayers: [teamTemporaryPlayerSchema],
    statistics: {
      played: { type: Number, default: 0 },
      won: { type: Number, default: 0 },
      drawn: { type: Number, default: 0 },
      lost: { type: Number, default: 0 },
      goalsFor: { type: Number, default: 0 },
      goalsAgainst: { type: Number, default: 0 },
      goalDifference: { type: Number, default: 0 },
      points: { type: Number, default: 0 },
    },
  },
  { timestamps: true }
);

teamSchema.pre("validate", function () {
  this.normalizedName = normalizeTeamName(this.teamName);
  if (this.termScope === "TERM" && !this.term) this.invalidate("term", "An academic term is required for a term-linked team.");
  if (this.termScope === "INDEPENDENT" && this.term) this.invalidate("term", "Independent teams cannot have an academic term.");
  if (this.termScope === "INDEPENDENT" && !this.year) this.invalidate("year", "A year is required for an independent team.");
  if ((this.startDate && !this.endDate) || (!this.startDate && this.endDate)) this.invalidate("endDate", "Provide team start and end dates together.");
  if (this.startDate && this.endDate && this.endDate < this.startDate) this.invalidate("endDate", "Team end date cannot be earlier than start date.");
});
teamSchema.index({ term: 1, normalizedName: 1 }, { unique: true, name: "team_term_normalized_name", partialFilterExpression: { normalizedName: { $type: "string" }, term: { $type: "objectId" } } });
teamSchema.index({ year: 1, normalizedName: 1 }, { unique: true, name: "team_independent_year_normalized_name", partialFilterExpression: { termScope: "INDEPENDENT", year: { $type: "number" }, normalizedName: { $type: "string" } } });
teamSchema.index({ termScope: 1, year: 1, archivedAt: 1 });
teamSchema.index({ "leagues.league": 1 });

teamSchema.set("toJSON", { transform: (_doc, result) => {
  result.termScope = result.term ? "TERM" : "INDEPENDENT";
  result.year ||= result.term?.year || (result.startDate ? new Date(result.startDate).getUTCFullYear() : undefined);
  if (result.startDate) result.startDate = dateOnly(result.startDate);
  if (result.endDate) result.endDate = dateOnly(result.endDate);
  if (result.sessionDates) result.sessionDates = result.sessionDates.map((date) => dateOnly(date));
  return result;
} });
module.exports = mongoose.model("Team", teamSchema);

