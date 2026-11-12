const nodemailer = require("nodemailer");

const createTransporter = () => {
  if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
    const error = new Error("Email is not configured.");
    error.code = "EMAIL_NOT_CONFIGURED";
    throw error;
  }

  const port = Number(process.env.EMAIL_PORT || 587);
  if (process.env.EMAIL_HOST && (!Number.isInteger(port) || port < 1 || port > 65535)) {
    const error = new Error("Invalid SMTP port.");
    error.code = "EMAIL_INVALID_PORT";
    throw error;
  }

  return nodemailer.createTransport({
    ...(process.env.EMAIL_HOST
      ? { host: process.env.EMAIL_HOST, port, secure: port === 465 }
      : { service: "gmail" }),
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 20000,
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS,
    },
  });
};

const sendEmailStrict = async (to, subject, html) => {
  const transporter = createTransporter();
  await transporter.sendMail({
    from: `"CoachMax" <${process.env.EMAIL_USER}>`,
    to,
    subject,
    html,
  });
  return true;
};

const sendEmail = async (to, subject, html) => {
  try {
    return await sendEmailStrict(to, subject, html);
  } catch (err) {
    console.error("Email delivery failed", { code: err.code || "SMTP_ERROR" });
    return false;
  }
};

const sendTestEmail = async (to) => {
  const transporter = createTransporter();
  const info = await transporter.sendMail({
    from: `"CoachMax" <${process.env.EMAIL_USER}>`,
    to,
    subject: "CoachMax email setup test",
    text: "This is a test email from CoachMax. Your configured email service accepted this message.",
    html: "<div style=\"font-family:Arial,sans-serif;color:#152238\"><h2>CoachMax email test</h2><p>Your configured email service accepted this test message.</p></div>",
  });
  return { messageId: info.messageId || null };
};

module.exports = sendEmail;
module.exports.sendEmailStrict = sendEmailStrict;
module.exports.sendTestEmail = sendTestEmail;
module.exports.createTransporter = createTransporter;
