// Purchase activation code email. Separate from the Supabase Auth
// trial/account template in supabase/templates/private_activation_code.html.
// The code contains only Crockford base32 characters, GF and hyphens, so it
// needs no HTML escaping; the guard below keeps it that way.
export function purchaseCodeEmail(
  formattedCode: string,
): { subject: string; html: string; text: string } {
  if (!/^GF(-[0-9A-HJKMNP-TV-Z]{4}){4}$/.test(formattedCode)) {
    throw new Error("invalid_purchase_code_format");
  }
  const subject = "Your Gesture Flow activation code";
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" />
    <meta name="referrer" content="no-referrer" />
    <title>${subject}</title>
  </head>
  <body>
    <h1>Thanks for buying Gesture Flow</h1>
    <p>Open Gesture Flow on your Mac, choose to activate a purchase, and enter this code:</p>
    <p style="font-family: ui-monospace, Menlo, monospace; font-size: 24px; letter-spacing: 2px;"><strong>${formattedCode}</strong></p>
    <p>The code activates one Mac and works only once. After activation, Gesture Flow remembers that Mac securely, so you do not need to enter it again.</p>
    <p>To move Gesture Flow to a new Mac later, sign in with this email at <a href="https://stuffbyrambo.com/license/">stuffbyrambo.com/license</a> and deactivate the old Mac.</p>
    <p>Keep this email private. If you have not used the code yet and need a new one, request another from Gesture Flow; any earlier unused code stops working.</p>
    <p>If you did not make this purchase, you can ignore this email.</p>
  </body>
</html>`;
  const text = [
    "Thanks for buying Gesture Flow.",
    "",
    "Open Gesture Flow on your Mac, choose to activate a purchase, and enter this code:",
    "",
    formattedCode,
    "",
    "The code activates one Mac and works only once. After activation, Gesture Flow remembers that Mac securely, so you do not need to enter it again.",
    "",
    "To move Gesture Flow to a new Mac later, sign in with this email at https://stuffbyrambo.com/license/ and deactivate the old Mac.",
    "",
    "Keep this email private. If you have not used the code yet and need a new one, request another from Gesture Flow; any earlier unused code stops working.",
    "",
    "If you did not make this purchase, you can ignore this email.",
  ].join("\n");
  return { subject, html, text };
}
