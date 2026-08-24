/**
 * Transactional Email Service via Resend API
 */
export async function sendEmail({ to, subject, html, text }) {
  const resendKey = process.env.RESEND_API_KEY;
  const fromEmail = process.env.RESEND_FROM_EMAIL || "StockShield Alert <onboarding@resend.dev>";
  const adminOwnerEmail = process.env.ADMIN_EMAIL || "sandeepptpss@gmail.com";

  if (!resendKey) {
    console.warn("[emailService] RESEND_API_KEY is not configured in .env. Skipping email dispatch.");
    return { success: false, error: "RESEND_API_KEY not configured" };
  }

  const requestedRecipient = Array.isArray(to) ? to[0] : to;

  // Resend API restriction: onboarding@resend.dev test domain ONLY permits delivering
  // emails to the account owner email (sandeepptpss@gmail.com). Sending to other recipients
  // returns HTTP 403. So in test mode, we route the email to sandeepptpss@gmail.com with header note.
  const isTestDomain = fromEmail.includes("onboarding@resend.dev");
  const actualRecipient =
    isTestDomain && requestedRecipient !== adminOwnerEmail
      ? adminOwnerEmail
      : requestedRecipient;

  const subjectPrefix =
    isTestDomain && requestedRecipient !== adminOwnerEmail
      ? `[To: ${requestedRecipient}] `
      : "";

  const finalSubject = `${subjectPrefix}${subject}`;

  const bodyText = text || html?.replace(/<[^>]+>/g, "") || "";
  const testNote =
    isTestDomain && requestedRecipient !== adminOwnerEmail
      ? `<div style="background:#fff3cd; color:#856404; padding:8px 12px; border-radius:4px; margin-bottom:12px; font-size:12px;">
          <strong>Resend Testing Mode:</strong> Intended recipient was <code>${requestedRecipient}</code>.
        </div>`
      : "";

  const bodyHtml = `${testNote}${html || `<p style="white-space: pre-wrap;">${bodyText}</p>`}`;

  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resendKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: fromEmail,
        to: [actualRecipient],
        subject: finalSubject,
        html: bodyHtml,
        text: bodyText,
      }),
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      console.error("[emailService] Resend API error:", response.status, data);
      return { success: false, error: data.message || `Resend HTTP ${response.status}` };
    }

    console.log(`[emailService] Transactional email successfully delivered via Resend to ${actualRecipient} (ID: ${data.id})`);
    return { success: true, id: data.id };
  } catch (error) {
    console.error("[emailService] Network error sending email via Resend:", error);
    return { success: false, error: error.message };
  }
}
