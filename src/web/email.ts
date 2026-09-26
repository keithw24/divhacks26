import nodemailer from "nodemailer";
import { maskEmail } from "./auth.js";

export interface MailerOptions {
  host: string;
  port: number;
  user: string;
  pass: string;
  from: string;
  /** Without SMTP settings, print emails to the log instead of failing (local development only). */
  devLog: boolean;
}

export interface Email {
  to: string;
  subject: string;
  text: string;
  html: string;
  attachments?: { filename: string; content: string; contentType: string }[];
}

export type Mailer = { configured: boolean; send(email: Email): Promise<void> };

/** SMTP mailer (Gmail app password, Resend, SendGrid, Postmark... anything with SMTP). */
export function createMailer(opts: MailerOptions): Mailer {
  const configured = Boolean(opts.host && opts.user && opts.pass && opts.from);
  const transport = configured
    ? nodemailer.createTransport({
        host: opts.host,
        port: opts.port,
        secure: opts.port === 465,
        auth: { user: opts.user, pass: opts.pass },
      })
    : undefined;

  return {
    configured,
    async send(email) {
      if (transport) {
        await transport.sendMail({ from: opts.from, ...email });
        return;
      }
      if (!opts.devLog) throw new Error("email is not configured (set SMTP_HOST, SMTP_USER, SMTP_PASS, EMAIL_FROM)");
      console.info(`[dev] email to ${maskEmail(email.to)}: ${email.subject}\n${email.text}`);
    },
  };
}

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** "+14155951440" → "(415) 595-1440" */
export function formatUsNumber(e164: string): string {
  const d = e164.replace(/\D/g, "").slice(-10);
  return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : e164;
}

export function codeEmail(to: string, code: string, appName: string): Email {
  return {
    to,
    subject: `${code} is your ${appName} code`,
    text: `Your ${appName} verification code is ${code}.\n\nIt expires in 10 minutes. If you didn't try to sign in, you can ignore this email.`,
    html: `<div style="font-family:system-ui,sans-serif;font-size:16px;line-height:1.5">
<p>Your ${escapeHtml(appName)} verification code is:</p>
<p style="font-size:32px;font-weight:700;letter-spacing:6px;margin:16px 0">${code}</p>
<p style="color:#666">It expires in 10 minutes. If you didn't try to sign in, you can ignore this email.</p></div>`,
  };
}

/** The agent's number, sent only to verified users (it is deliberately not on the website). */
export function agentNumberEmail(to: string, opts: { name?: string; appName: string; agentName: string; agentNumber: string }): Email {
  const pretty = formatUsNumber(opts.agentNumber);
  const hi = opts.name ? `Hey ${opts.name},` : "Hey,";
  const mention = `@${opts.agentName.toLowerCase()}`;
  const vcard = ["BEGIN:VCARD", "VERSION:3.0", `FN:${opts.appName} (${mention})`, `ORG:${opts.appName}`, `TEL;TYPE=CELL:${opts.agentNumber}`, "END:VCARD", ""].join("\r\n");
  const steps = [
    "Open the attached contact card and save it, so the agent shows up by name.",
    `Text it directly, or add it to a group chat and mention ${mention} when you need it.`,
    `Try: "what should we do tonight?", "how do we get there?", "is this walk okay at midnight?". Voice memos work too.`,
  ];
  return {
    to,
    subject: `Your ${mention} number`,
    text: `${hi}\n\nYou're in. Text ${mention} at ${pretty} (${opts.agentNumber}).\n\n${steps.map((s, i) => `${i + 1}. ${s}`).join("\n")}\n\nPlease keep this number to yourself and people you add to group chats: the beta is limited to 100 people.`,
    html: `<div style="font-family:system-ui,sans-serif;font-size:16px;line-height:1.5">
<p>${escapeHtml(hi)}</p>
<p>You're in. Text ${escapeHtml(mention)} at:</p>
<p style="font-size:28px;font-weight:700;margin:12px 0"><a href="sms:${opts.agentNumber}" style="color:#111;text-decoration:none">${pretty}</a></p>
<ol>${steps.map((s) => `<li>${escapeHtml(s)}</li>`).join("")}</ol>
<p style="color:#666">Please keep this number to yourself and people you add to group chats: the beta is limited to 100 people.</p></div>`,
    attachments: [{ filename: `${opts.appName}-agent.vcf`, content: vcard, contentType: "text/vcard" }],
  };
}
