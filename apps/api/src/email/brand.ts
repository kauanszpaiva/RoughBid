/** Shared production identity for RoughBid transactional email. Never use an
 * authenticated image URL: mail clients must be able to fetch the logo. */
export const ROUGHBID_EMAIL_LOGO_URL = 'https://roughbid.vercel.app/brand/roughbid-logo-email.png';
export const ROUGHBID_EMAIL_FROM = 'RoughBid <hello@mail.kspdominion.group>';

export function roughbidEmailFrom(env: NodeJS.ProcessEnv = process.env): string {
  return env.RESEND_FROM_EMAIL?.trim() || ROUGHBID_EMAIL_FROM;
}

export function roughbidEmailLogoUrl(env: NodeJS.ProcessEnv = process.env): string {
  try {
    const appUrl = new URL(env.APP_URL?.trim() || 'https://roughbid.vercel.app');
    if (appUrl.protocol === 'https:' && !appUrl.username && !appUrl.password) {
      return new URL('/brand/roughbid-logo-email.png', appUrl).toString();
    }
  } catch { /* Preserve the existing public logo when APP_URL is unavailable. */ }
  return ROUGHBID_EMAIL_LOGO_URL;
}

export const escapeEmailHtml = (value: string): string => value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]!));
export const roughbidEmailLogoHtml = (env: NodeJS.ProcessEnv = process.env) => `<img src="${escapeEmailHtml(roughbidEmailLogoUrl(env))}" alt="RoughBid" width="240" height="80" border="0" style="display:block;width:240px;max-width:100%;height:auto;border-width:0;outline:none;text-decoration:none;" />`;

/** Table layout and inline styles work in clients that strip page CSS. All
 * caller content and URLs are escaped here; plaintext email remains separate. */
export function roughbidEmailHtml(input: { title: string; paragraphs: string[]; action: { label: string; url: string }; footer: string }) {
  const actionUrl = new URL(input.action.url);
  if (actionUrl.protocol !== 'https:') throw new TypeError('Email action URL must use HTTPS.');
  const textStyle = 'font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:22px;color:#475569;';
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><meta http-equiv="X-UA-Compatible" content="IE=edge"><title>${escapeEmailHtml(input.title)}</title></head><body style="margin-top:0;margin-right:0;margin-bottom:0;margin-left:0;background-color:#f8fafc;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;background-color:#f8fafc;"><tr><td align="center" bgcolor="#f8fafc" style="padding-top:32px;padding-right:16px;padding-bottom:32px;padding-left:16px;background-color:#f8fafc;"><table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;background-color:#ffffff;border-width:1px;border-style:solid;border-color:#e2e8f0;"><tr><td bgcolor="#ffffff" style="padding-top:28px;padding-right:28px;padding-bottom:24px;padding-left:28px;background-color:#ffffff;">${roughbidEmailLogoHtml()}</td></tr><tr><td bgcolor="#ffffff" style="padding-top:0;padding-right:28px;padding-bottom:16px;padding-left:28px;background-color:#ffffff;font-family:Arial,Helvetica,sans-serif;font-size:22px;line-height:30px;color:#0f172a;font-weight:700;">${escapeEmailHtml(input.title)}</td></tr>${input.paragraphs.map((paragraph) => `<tr><td bgcolor="#ffffff" style="padding-top:0;padding-right:28px;padding-bottom:16px;padding-left:28px;background-color:#ffffff;${textStyle}">${escapeEmailHtml(paragraph)}</td></tr>`).join('')}<tr><td align="left" bgcolor="#ffffff" style="padding-top:4px;padding-right:28px;padding-bottom:28px;padding-left:28px;background-color:#ffffff;"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td bgcolor="#2563eb" style="background-color:#2563eb;"><a href="${escapeEmailHtml(actionUrl.toString())}" style="display:inline-block;padding-top:12px;padding-right:18px;padding-bottom:12px;padding-left:18px;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:18px;color:#ffffff;text-decoration:none;font-weight:700;">${escapeEmailHtml(input.action.label)}</a></td></tr></table></td></tr><tr><td bgcolor="#f8fafc" style="padding-top:16px;padding-right:28px;padding-bottom:16px;padding-left:28px;background-color:#f8fafc;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:18px;color:#64748b;">${escapeEmailHtml(input.footer)}</td></tr></table></td></tr></table></body></html>`;
}
