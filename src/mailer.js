// ============================================================
// Email notifications (Yahoo SMTP via nodemailer).
// Credentials are read from .env only (never hard-coded):
//   EMAIL_USER, EMAIL_APP_PASSWORD, EMAIL_FROM, EMAIL_TO
// A throttle prevents flooding the inbox when the app is opened
// or hot-reloaded repeatedly.
// ============================================================
import nodemailer from 'nodemailer';
import { config, hasEmail } from './config.js';

let transporter = null;
if (hasEmail) {
  transporter = nodemailer.createTransport({
    host: config.emailHost,
    port: config.emailPort,
    secure: config.emailPort === 465, // SSL for 465, STARTTLS otherwise
    auth: { user: config.emailUser, pass: config.emailPassword },
  });
  console.log(`[mail] email notifications enabled (from ${config.emailFrom} -> ${config.emailTo})`);
} else {
  console.log('[mail] email disabled (set EMAIL_USER + EMAIL_APP_PASSWORD in .env to enable)');
}

let lastSentAt = 0;

// Sends the "application opened" notification, throttled to at most once per
// config.emailThrottleMinutes. Returns a small status object.
export async function sendOpenNotification(summary = {}) {
  if (!transporter) return { sent: false, reason: 'email-disabled' };

  const throttleMs = config.emailThrottleMinutes * 60 * 1000;
  const sinceLast = Date.now() - lastSentAt;
  if (lastSentAt && sinceLast < throttleMs) {
    return { sent: false, reason: 'throttled', nextInMs: throttleMs - sinceLast };
  }

  const when = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
  const {
    resultsToday = 0,
    strongResults = 0,
    averageResults = 0,
    weakResults = 0,
    highestScoreToday = null,
  } = summary;

  const highestLine = highestScoreToday
    ? `${highestScoreToday.ticker} (${highestScoreToday.company || ''}) — ${highestScoreToday.score}/10`
    : 'n/a';

  const text =
    `Indian Earnings Intelligence was opened at ${when} IST.\n\n` +
    `Snapshot of the current window:\n` +
    `- Results today: ${resultsToday}\n` +
    `- Strong results: ${strongResults}\n` +
    `- Average results: ${averageResults}\n` +
    `- Weak results: ${weakResults}\n` +
    `- Highest score: ${highestLine}\n`;

  const html =
    `<h2 style="margin:0 0 8px">Indian Earnings Intelligence opened</h2>` +
    `<p style="color:#555">${when} IST</p>` +
    `<table style="border-collapse:collapse;font-family:system-ui,Arial">` +
    `<tr><td style="padding:4px 12px 4px 0">Results today</td><td><b>${resultsToday}</b></td></tr>` +
    `<tr><td style="padding:4px 12px 4px 0">Strong results</td><td><b style="color:#059669">${strongResults}</b></td></tr>` +
    `<tr><td style="padding:4px 12px 4px 0">Average results</td><td><b style="color:#ca8a04">${averageResults}</b></td></tr>` +
    `<tr><td style="padding:4px 12px 4px 0">Weak results</td><td><b style="color:#e11d48">${weakResults}</b></td></tr>` +
    `<tr><td style="padding:4px 12px 4px 0">Highest score</td><td><b>${highestLine}</b></td></tr>` +
    `</table>`;

  try {
    await transporter.sendMail({
      from: config.emailFrom,
      to: config.emailTo,
      subject: `Earnings screener opened — ${resultsToday} result(s) today`,
      text,
      html,
    });
    lastSentAt = Date.now();
    console.log(`[mail] open notification sent to ${config.emailTo}`);
    return { sent: true };
  } catch (err) {
    console.warn('[mail] send failed:', err.message);
    return { sent: false, reason: 'error', detail: err.message };
  }
}
