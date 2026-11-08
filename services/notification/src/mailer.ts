import nodemailer from 'nodemailer';
import type { Mailer } from './notifier';

export function smtpMailer(smtpUrl: string, from: string): Mailer & { verify(): Promise<unknown>; close(): void } {
  const transport = nodemailer.createTransport(smtpUrl, { from });
  return {
    async send(m) {
      await transport.sendMail({ from, to: m.to, subject: m.subject, html: m.html, text: m.text });
    },
    verify: () => transport.verify(),
    close: () => transport.close(),
  };
}
