import { Resend } from "resend";

const apiKey = process.env.RESEND_API_KEY;
const fromAddress = process.env.ALERTS_FROM_EMAIL || "alerts@chainscope.dev";

const resend = apiKey ? new Resend(apiKey) : null;

export interface SendEmailInput {
  to: string;
  subject: string;
  html: string;
}

/**
 * Sends via Resend when RESEND_API_KEY is configured; otherwise logs to the
 * console so alert-checking logic is fully testable without a real key.
 */
export async function sendEmail({ to, subject, html }: SendEmailInput): Promise<void> {
  if (!resend) {
    console.log(`[email:dev-mode] to=${to} subject="${subject}"\n${html}`);
    return;
  }

  const { error } = await resend.emails.send({ from: fromAddress, to, subject, html });
  if (error) {
    console.error(`[email] failed to send to ${to}:`, error);
  }
}
