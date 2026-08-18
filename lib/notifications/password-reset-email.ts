// Same inline-styled table layout as the alert-triggered email
// (workers/alerts/check.ts's alertEmailHtml) - external CSS gets stripped by
// most email clients, so both templates share this approach rather than a
// stylesheet.
function emailShell(params: { eyebrow: string; heading: string; bodyHtml: string; appUrl: string }): string {
  return `
<!DOCTYPE html>
<html>
  <body style="margin:0;padding:0;background-color:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e4e4e7;">
            <tr>
              <td style="padding:24px 32px;border-bottom:1px solid #e4e4e7;">
                <span style="font-size:18px;font-weight:700;color:#18181b;">DeFiHub</span>
              </td>
            </tr>
            <tr>
              <td style="padding:32px;">
                <p style="margin:0 0 8px;font-size:13px;font-weight:600;letter-spacing:0.05em;text-transform:uppercase;color:#3987e5;">
                  ${params.eyebrow}
                </p>
                <h1 style="margin:0 0 16px;font-size:22px;line-height:1.3;color:#18181b;">${params.heading}</h1>
                ${params.bodyHtml}
              </td>
            </tr>
            <tr>
              <td style="padding:16px 32px;border-top:1px solid #e4e4e7;">
                <p style="margin:0;font-size:12px;color:#a1a1aa;">
                  You're receiving this because a password reset was requested for your DeFiHub account. If this wasn't you, no action is needed.
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

function button(href: string, label: string): string {
  return `<a href="${href}" style="display:inline-block;background:#3987e5;color:#ffffff;text-decoration:none;font-size:14px;font-weight:600;padding:10px 20px;border-radius:8px;">${label}</a>`;
}

export function passwordResetEmailHtml(params: { resetUrl: string; appUrl: string }): string {
  return emailShell({
    eyebrow: "Reset your password",
    heading: "Password reset requested",
    appUrl: params.appUrl,
    bodyHtml: `
      <p style="margin:0 0 24px;font-size:15px;line-height:1.6;color:#3f3f46;">
        Click below to choose a new password. This link expires in 1 hour and can only be used once.
      </p>
      ${button(params.resetUrl, "Reset password")}
    `,
  });
}

// Google is the only OAuth provider this app registers (see
// googleSignInEnabled in lib/auth/config.ts) - not worth generalizing a
// "provider" param for a single hardcoded possibility.
/** Sent instead of a reset link when the account only has a Google identity (no password to reset). */
export function oauthOnlyAccountEmailHtml(params: { appUrl: string }): string {
  return emailShell({
    eyebrow: "Password reset requested",
    heading: "You signed up with Google",
    appUrl: params.appUrl,
    bodyHtml: `
      <p style="margin:0 0 24px;font-size:15px;line-height:1.6;color:#3f3f46;">
        This account doesn't have a password - it was created by signing in with Google. Use the "Continue with Google" button on the sign-in page instead.
      </p>
      ${button(`${params.appUrl}/login`, "Go to sign in")}
    `,
  });
}
