// Email sending via the Cloudflare Workers EMAIL binding (send_email in
// wrangler.jsonc). Defaults below are overridable per-key via the
// email_templates table; {{variable}} placeholders are substituted at send
// time. Email failures are logged and swallowed — a broken mail path must
// never take down the request that triggered it.

// key → { subject, body, label, description, variables }. Only subject/body
// are sent; the rest is metadata for the /admin/emails editor.
export const EMAIL_TEMPLATE_DEFAULTS = {
  verify_email: {
    label: 'Verify email address',
    description: 'Sent to a reader after registration with a link to verify their email address.',
    variables: ['{{site_name}}', '{{username}}', '{{link}} — verification URL (expires in 24 h)'],
    subject: 'Verify your email address for {{site_name}}',
    body: `<p>Hi {{username}},</p>
<p>Thanks for registering on <strong>{{site_name}}</strong>. Please verify your email address by opening this link:</p>
<p><a href="{{link}}">{{link}}</a></p>
<p>This link expires in 24 hours. If you did not register, you can safely ignore this email.</p>`,
  },

  reset_password: {
    label: 'Password reset',
    description: 'Sent when someone requests a password reset for an admin or reader account. The link expires in 1 hour and can be used once.',
    variables: ['{{site_name}}', '{{name}}', '{{link}} — reset URL (expires in 1 hour)'],
    subject: 'Reset your {{site_name}} password',
    body: `<p>Hi {{name}},</p>
<p>We received a request to reset the password for your <strong>{{site_name}}</strong> account. Open this link to choose a new password:</p>
<p><a href="{{link}}">{{link}}</a></p>
<p>This link expires in 1 hour and can only be used once. If you didn't request this, you can safely ignore this email — your password won't change.</p>`,
  },

  account_approved: {
    label: 'Account approved',
    description: 'Sent to a reader when their account is approved.',
    variables: ['{{site_name}}', '{{username}}', '{{link}} — login page URL'],
    subject: 'Your {{site_name}} account has been approved',
    body: `<p>Hi {{username}},</p>
<p>Good news — your <strong>{{site_name}}</strong> account has been approved. You can now log in:</p>
<p><a href="{{link}}">{{link}}</a></p>
<p>Welcome aboard!</p>`,
  },

  account_rejected: {
    label: 'Account not approved',
    description: 'Sent to a reader when their registration is rejected.',
    variables: ['{{site_name}}', '{{username}}'],
    subject: 'Update on your {{site_name}} account registration',
    body: `<p>Hi {{username}},</p>
<p>Thank you for registering on <strong>{{site_name}}</strong>. Unfortunately your account registration was not approved at this time.</p>
<p>If you believe this is a mistake, please contact the site owner.</p>`,
  },

  new_article: {
    label: 'New article notification',
    description: 'Sent to blog subscribers when a new article is published.',
    variables: ['{{site_name}}', '{{username}}', '{{article_title}}', '{{link}} — article URL'],
    subject: 'New on {{site_name}}: {{article_title}}',
    body: `<p>Hi {{username}},</p>
<p>A new article has been published on <strong>{{site_name}}</strong>:</p>
<p><strong>{{article_title}}</strong><br><a href="{{link}}">{{link}}</a></p>
<p style="font-size:0.85em;color:#64748b">You're receiving this because you subscribed to the blog. Manage your preferences in your reader settings.</p>`,
  },

  comment_reply: {
    label: 'Comment reply notification',
    description: 'Sent to a reader when someone replies to one of their comments.',
    variables: ['{{site_name}}', '{{username}}', '{{reply_author}}', '{{article_title}}', '{{link}} — article URL'],
    subject: '{{reply_author}} replied to your comment on {{site_name}}',
    body: `<p>Hi {{username}},</p>
<p><strong>{{reply_author}}</strong> replied to your comment on <strong>{{article_title}}</strong>:</p>
<p><a href="{{link}}">{{link}}</a></p>
<p style="font-size:0.85em;color:#64748b">Manage your notification preferences in your reader settings.</p>`,
  },

  comment_moderated: {
    label: 'Comment moderated notification',
    description: 'Sent to a reader when their comment is approved or rejected. {{status}} is "approved" or "not approved".',
    variables: ['{{site_name}}', '{{username}}', '{{article_title}}', '{{status}}', '{{link}} — article URL'],
    subject: 'Your comment on {{site_name}} was {{status}}',
    body: `<p>Hi {{username}},</p>
<p>Your comment on <strong>{{article_title}}</strong> was <strong>{{status}}</strong>.</p>
<p><a href="{{link}}">{{link}}</a></p>
<p style="font-size:0.85em;color:#64748b">Manage your notification preferences in your reader settings.</p>`,
  },

  admin_new_registration: {
    label: 'Admin — new reader registration',
    description: 'Sent to CMS users (with the flag enabled) when a reader registers or verifies their email.',
    variables: ['{{site_name}}', '{{username}}', '{{email}}', '{{status_line}}', '{{link}} — admin readers page'],
    subject: 'Reader registration on {{site_name}}: {{username}}',
    body: `<p>A reader account on <strong>{{site_name}}</strong> needs your attention:</p>
<p><strong>Username:</strong> {{username}}<br><strong>Email:</strong> {{email}}</p>
<p>{{status_line}}</p>
<p><a href="{{link}}">{{link}}</a></p>`,
  },

  admin_new_comment: {
    label: 'Admin — new comment awaiting moderation',
    description: 'Sent to CMS users (with the flag enabled) when a comment or reply is submitted.',
    variables: ['{{site_name}}', '{{commenter}}', '{{article_title}}', '{{comment_body}}', '{{link}} — admin comments page'],
    subject: 'New comment awaiting moderation on {{site_name}}',
    body: `<p>A new comment on <strong>{{article_title}}</strong> is awaiting review on <strong>{{site_name}}</strong>:</p>
<p><strong>From:</strong> {{commenter}}</p>
<blockquote style="border-left:3px solid #ccc;margin:1em 0;padding:0.3em 1em;font-style:italic">{{comment_body}}</blockquote>
<p><a href="{{link}}">{{link}}</a></p>`,
  },

  admin_new_correction: {
    label: 'Admin — new correction submitted',
    description: 'Sent to CMS users (with the flag enabled) when a correction is submitted.',
    variables: ['{{site_name}}', '{{entity_type}}', '{{entity_title}}', '{{correction_body}}', '{{link}} — admin corrections page'],
    subject: 'New correction submitted on {{site_name}}',
    body: `<p>A correction has been suggested for the {{entity_type}} <strong>{{entity_title}}</strong> on <strong>{{site_name}}</strong>:</p>
<blockquote style="border-left:3px solid #ccc;margin:1em 0;padding:0.3em 1em;font-style:italic">{{correction_body}}</blockquote>
<p><a href="{{link}}">{{link}}</a></p>`,
  },
};

// {{key}} → vars[key]; unknown placeholders are left visible so a template
// typo is obvious in the received email rather than silently blank.
export function renderTemplate(str, vars = {}) {
  return String(str).replace(/\{\{(\w+)\}\}/g, (_, key) => (vars[key] !== undefined ? String(vars[key]) : `{{${key}}}`));
}

// Crude HTML → plain-text for the multipart text alternative.
function htmlToText(htmlStr) {
  return String(htmlStr)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<\/h[1-6]>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Site display name for emails: org_name setting, then env fallback.
export async function getSiteName(env) {
  try {
    const row = await env.DB.prepare(`SELECT value FROM site_settings WHERE key = 'org_name'`).first();
    return row?.value || env.SITE_TITLE || 'My Site';
  } catch {
    return env.SITE_TITLE || 'My Site';
  }
}

// Is outgoing email available AND switched on? False when the send_email
// binding is absent (e.g. Workers Free plan / no domain) or when an admin has
// turned email off in Settings ('email_enabled' = '0'). When false the CMS
// runs in "no-email mode": sends are skipped and the sign-up / password flows
// adapt so no one gets stranded. Absent setting = on (matches other toggles).
export async function emailEnabled(env) {
  if (!env.EMAIL) return false;
  try {
    const row = await env.DB.prepare("SELECT value FROM site_settings WHERE key = 'email_enabled'").first();
    return (row?.value ?? '1') !== '0';
  } catch {
    return false;
  }
}

// Low-level send. Mirrors the writing project's EMAIL binding usage:
// message object with from/to/subject/html/text handed to env.EMAIL.send().
export async function sendEmail(env, { to, subject, html }) {
  if (!(await emailEnabled(env))) {
    console.warn('[email] disabled or no binding — skipping email to', to, '|', subject);
    return;
  }
  const from = env.SITE_EMAIL_FROM || 'noreply@example.com';
  try {
    await env.EMAIL.send({
      from,
      to: Array.isArray(to) ? to[0] : to,
      subject,
      html,
      text: htmlToText(html),
    });
  } catch (err) {
    console.error('[email] Send error for', to, ':', err?.message || err);
  }
}

// High-level send: DB email_templates row overlays the code default for the
// key, variables are substituted, then the message goes out. Never throws.
export async function sendTemplatedEmail(env, key, to, vars = {}) {
  try {
    const defaults = EMAIL_TEMPLATE_DEFAULTS[key];
    if (!defaults) { console.warn('[email] Unknown template key:', key); return; }

    const row = await env.DB.prepare('SELECT subject, body FROM email_templates WHERE key = ?')
      .bind(key).first().catch(() => null);

    const subject = renderTemplate(row?.subject ?? defaults.subject, vars);
    const body    = renderTemplate(row?.body    ?? defaults.body,    vars);

    await sendEmail(env, { to, subject, html: body });
  } catch (err) {
    console.error('[email] sendTemplatedEmail failed for', key, '→', to, ':', err?.message || err);
  }
}

// Notify every active CMS user whose per-user flag is on. flag is restricted
// to a whitelist because it is interpolated into SQL as a column name.
const ADMIN_NOTIFY_FLAGS = new Set(['notify_new_registration', 'notify_new_comment', 'notify_new_correction']);

export async function notifyAdmins(env, flag, templateKey, vars = {}) {
  if (!ADMIN_NOTIFY_FLAGS.has(flag)) { console.warn('[email] Unknown admin notify flag:', flag); return; }
  try {
    const { results } = await env.DB.prepare(
      `SELECT email FROM users WHERE active = 1 AND ${flag} = 1 AND email IS NOT NULL`
    ).all();
    for (const row of results || []) {
      await sendTemplatedEmail(env, templateKey, row.email, vars);
    }
  } catch (err) {
    console.error('[email] notifyAdmins failed for', templateKey, ':', err?.message || err);
  }
}
