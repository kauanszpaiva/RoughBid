import { writeFileSync } from 'node:fs';

// Local artifact generation only. This script never calls Supabase or sends email.
const logo = 'https://roughbid.vercel.app/brand/roughbid-logo-email.png';
const templates = [
  ['confirmation','Confirm your RoughBid account','Welcome to RoughBid','Confirm your email address to finish creating your account.','Confirm email address'],
  ['magic_link','Your secure RoughBid sign-in link','Sign in to RoughBid','Use this secure, single-use link to open your account.','Sign in to RoughBid'],
  ['recovery','Reset your RoughBid password','Reset your password','You requested a password reset for your RoughBid account. Continue to choose a new password.','Reset password'],
  ['invite','You are invited to RoughBid','Your RoughBid invitation','You have been invited to create a RoughBid account. Confirm your email to continue.','Accept invitation'],
  ['email_change','Confirm your RoughBid email change','Confirm your email change','Confirm the requested change from {{ .Email }} to {{ .NewEmail }}.','Confirm email change'],
  ['reauthentication','Your RoughBid verification code','Verify your identity','Use the following code to confirm the action you requested in RoughBid. Do not share this code with anyone.',null],
  ['password_changed_notification','Your RoughBid password was changed','Your password was changed','The password for your RoughBid account was changed. If this was not you, review your account access and contact support.',null],
  ['email_changed_notification','Your RoughBid email address was changed','Your email address was changed','Your RoughBid email address was changed from {{ .OldEmail }} to {{ .Email }}. If this was not you, review your account access and contact support.',null],
  ['phone_changed_notification','Your RoughBid phone number was changed','Your phone number was changed','Your account phone number was changed from {{ .OldPhone }} to {{ .Phone }}. If this was not you, review your account access and contact support.',null],
  ['identity_linked_notification','A sign-in method was added to RoughBid','A sign-in method was added','Your {{ .Provider }} account was linked as a sign-in method for {{ .Email }}. If this was not you, review your account access and contact support.',null],
  ['identity_unlinked_notification','A sign-in method was removed from RoughBid','A sign-in method was removed','Your {{ .Provider }} account was removed as a sign-in method for {{ .Email }}. If this was not you, review your account access and contact support.',null],
  ['mfa_factor_enrolled_notification','A verification method was added to RoughBid','A verification method was added','Sign-in verification method {{ .FactorType }} was added to your RoughBid account. If this was not you, review your account access and contact support.',null],
  ['mfa_factor_unenrolled_notification','A verification method was removed from RoughBid','A verification method was removed','Sign-in verification method {{ .FactorType }} was removed from your RoughBid account. If this was not you, review your account access and contact support.',null],
];
const payload = {};
for (const [name,subject,title,copy,button] of templates) {
  const action = button ? `<p style="margin:28px 0"><a href="{{ .ConfirmationURL }}" style="display:inline-block;background:#2563eb;color:#ffffff;padding:14px 22px;text-decoration:none;border-radius:6px;font-weight:700">${button}</a></p><p style="font-size:12px;line-height:20px;color:#64748b;word-break:break-all">If the button does not work, copy this link into your browser:<br><a href="{{ .ConfirmationURL }}" style="color:#2563eb">{{ .ConfirmationURL }}</a></p>`
    : name==='reauthentication' ? '<p style="font-size:30px;letter-spacing:6px;font-weight:700;color:#0f172a">{{ .Token }}</p>' : '';
  const footer = name.endsWith('_notification') ? 'This is an account security notification from RoughBid.' : 'If you did not request this, you can ignore this email. Never forward a sign-in link or verification code.';
  const html = `<!doctype html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${subject}</title></head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:Arial,Helvetica,sans-serif;color:#0f172a">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f1f5f9"><tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;background:#ffffff;border:1px solid #e2e8f0;border-radius:12px"><tr><td style="padding:32px">
<img src="${logo}" width="190" alt="RoughBid" style="display:block;width:190px;max-width:100%;height:auto;border:0;margin:0 0 32px">
<h1 style="margin:0 0 18px;font-size:25px;line-height:32px;font-weight:700">${title}</h1>
<p style="margin:0;font-size:15px;line-height:25px;color:#475569">${copy}</p>
${action}
<p style="margin:28px 0 0;padding-top:20px;border-top:1px solid #e2e8f0;font-size:12px;line-height:20px;color:#64748b">${footer}</p>
</td></tr></table>
<p style="margin:20px 0 0;font-size:12px;color:#64748b">RoughBid · Secure account access</p>
</td></tr></table></body></html>
`;
  writeFileSync(new URL(`./${name}.html`,import.meta.url),html);
  payload[`mailer_subjects_${name}`]=subject;
  payload[`mailer_templates_${name}_content`]=html;
}
writeFileSync(new URL('./auth-config.templates.json',import.meta.url),JSON.stringify(payload,null,2)+'\n');
console.log(`Prepared ${templates.length} local templates; no remote changes.`);
