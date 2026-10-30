const mongoose = require("mongoose");

const adminSessionSchema = new mongoose.Schema({
    tokenHash: { type: String, required: true },
    source: { type: String, enum: ["Web", "App", "Unknown"], default: "Unknown" },
    device: { type: String, default: "Unknown device" },
    ipAddress: { type: String, default: "" },
    userAgent: { type: String, default: "" },
    fcmToken: { type: String, default: "" },
    signedInAt: { type: Date, default: Date.now },
    lastSeenAt: { type: Date, default: Date.now },
});

const adminSchema = new mongoose.Schema(
    {
        name: String,

        email: {
            type: String,
            unique: true,
            required: true,
        },

        mobile: {
            type: String,
            unique: true,
            required: true,
        },
        profileImage: { type: String, default: null },
        otp: String,
        otpExpire: Date,
        isOtpVerified: { type: Boolean, default: false },
        otpAttempts: { type: Number, default: 0 },
        resetTokenHash: { type: String, select: false },
        resetTokenExpire: { type: Date, select: false },
        password: {
            type: String,
            required: true,
        },
        tokens: [
            {
                type: String,
            }
        ],
        fcmTokens: [
            {
                type: String,
            }
        ],
        // Keep the small active-device list with the staff account. Atlas Free
        // cannot create another collection when its 500-collection cap is reached.
        sessions: { type: [adminSessionSchema], select: false, default: [] },
        role: {
            type: String,
            enum: ["SUPER_ADMIN", "COACH"],
            default: "COACH",
        },
        isActive: {
            type: Boolean,
            default: true,
        },
        accessMode: {
            type: String,
            enum: ["FULL", "PARTIAL"],
            default: "PARTIAL",
        },
        permissions: {
            type: mongoose.Schema.Types.Mixed,
            default: () => ({}),
        },
    },
    { timestamps: true }
);

module.exports = mongoose.model("Admin", adminSchema);
