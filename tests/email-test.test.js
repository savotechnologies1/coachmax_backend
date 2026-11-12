const test = require("node:test");
const assert = require("node:assert/strict");
const nodemailer = require("nodemailer");
const { sendTestEmail } = require("../utils/sendEmail");
const { sendTestEmail: sendTestEmailController } = require("../controllers/emailCampaignController");

const envKeys = ["EMAIL_USER", "EMAIL_PASS", "EMAIL_HOST", "EMAIL_PORT"];
const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
const restoreEnv = () => envKeys.forEach((key) => {
  if (originalEnv[key] === undefined) delete process.env[key];
  else process.env[key] = originalEnv[key];
});

test.after(restoreEnv);

test("test email uses the configured SMTP transport and returns the accepted message id", async () => {
  process.env.EMAIL_USER = "coachmax@example.invalid";
  process.env.EMAIL_PASS = "test-only-password";
  process.env.EMAIL_HOST = "smtp.example.invalid";
  process.env.EMAIL_PORT = "465";

  let capturedOptions;
  let capturedMessage;
  const fakeTransport = test.mock.method(nodemailer, "createTransport", (options) => {
    capturedOptions = options;
    return {
      sendMail: async (message) => {
        capturedMessage = message;
        return { messageId: "test-message-id" };
      },
    };
  });

  try {
    const result = await sendTestEmail("test-recipient@example.invalid");
    assert.equal(capturedOptions.host, "smtp.example.invalid");
    assert.equal(capturedOptions.port, 465);
    assert.equal(capturedOptions.secure, true);
    assert.equal(capturedMessage.to, "test-recipient@example.invalid");
    assert.match(capturedMessage.subject, /CoachMax email setup test/);
    assert.match(capturedMessage.text, /accepted this message/);
    assert.deepEqual(result, { messageId: "test-message-id" });
  } finally {
    fakeTransport.mock.restore();
    restoreEnv();
  }
});

test("test email reports missing SMTP credentials without attempting delivery", async () => {
  delete process.env.EMAIL_USER;
  delete process.env.EMAIL_PASS;
  let transportCreated = false;
  const fakeTransport = test.mock.method(nodemailer, "createTransport", () => {
    transportCreated = true;
    return { sendMail: async () => ({}) };
  });

  try {
    await assert.rejects(sendTestEmail("test-recipient@example.invalid"), { code: "EMAIL_NOT_CONFIGURED" });
    assert.equal(transportCreated, false);
  } finally {
    fakeTransport.mock.restore();
    restoreEnv();
  }
});

test("admin test-email endpoint sends one message and rate-limits repeat clicks", async () => {
  process.env.EMAIL_USER = "coachmax@example.invalid";
  process.env.EMAIL_PASS = "test-only-password";
  delete process.env.EMAIL_HOST;
  delete process.env.EMAIL_PORT;

  let acceptedMessages = 0;
  const fakeTransport = test.mock.method(nodemailer, "createTransport", () => ({
    sendMail: async () => {
      acceptedMessages += 1;
      return { messageId: "controller-test-message" };
    },
  }));
  const response = () => ({
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  });

  try {
    const request = { admin: { _id: "email-test-admin" }, body: { email: "Admin.Test@example.invalid" } };
    const firstResponse = response();
    await sendTestEmailController(request, firstResponse);
    assert.equal(firstResponse.statusCode, 200);
    assert.equal(firstResponse.body.data.recipient, "admin.test@example.invalid");
    assert.match(firstResponse.body.message, /Check the inbox and spam folder/);

    const repeatedResponse = response();
    await sendTestEmailController(request, repeatedResponse);
    assert.equal(repeatedResponse.statusCode, 429);
    assert.equal(acceptedMessages, 1);
  } finally {
    fakeTransport.mock.restore();
    restoreEnv();
  }
});
