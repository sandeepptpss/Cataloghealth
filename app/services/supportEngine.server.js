import prisma from "../db.server.js";
import { getPlanConfig, normalizePlanId } from "./planEngine.server.js";
import { sendEmail } from "./emailService.server.js";

export const TICKET_STATUS = {
  OPEN: "OPEN",
  ANSWERED: "ANSWERED",
  RESOLVED: "RESOLVED",
};

const MAX_SUBJECT = 255;

const ticketInclude = {
  messages: { orderBy: { createdAt: "asc" } },
};

function cleanText(value) {
  return (value ?? "").toString().trim();
}

/** Response-time promise for the plan a ticket was raised on. */
export function ticketSlaLabel(planAtSubmission) {
  return getPlanConfig(planAtSubmission).supportSla;
}

/** Raise a ticket with its opening message. */
export async function createTicket({ storeId, subject, message, merchantEmail, contactEmail, plan }) {
  const cleanSubject = cleanText(subject).slice(0, MAX_SUBJECT);
  const cleanMessage = cleanText(message);
  const contact = cleanText(merchantEmail || contactEmail);

  if (!cleanSubject || !cleanMessage) {
    return {
      success: false,
      error: "A subject and a detailed message are both required to open a ticket.",
    };
  }

  if (contact && !contact.includes("@")) {
    return { success: false, error: `"${contact}" is not a valid email address.` };
  }

  const adminEmail = process.env.ADMIN_EMAIL || "sandeepptpss@gmail.com";
  const now = new Date();

  // Retrieve store shop domain for context
  const store = await prisma.store.findUnique({
    where: { id: storeId },
    select: { shopDomain: true, adminEmail: true, plan: true },
  });
  const shopDomain = store?.shopDomain || "Unknown Store";
  const finalMerchantEmail = contact || store?.adminEmail || adminEmail;
  const storePlan = plan || store?.plan;

  const ticket = await prisma.supportTicket.create({
    data: {
      storeId,
      subject: cleanSubject,
      message: cleanMessage,
      merchantEmail: finalMerchantEmail,
      status: TICKET_STATUS.OPEN,
      planAtSubmission: normalizePlanId(storePlan) || "free",
      lastMessageAt: now,
      messages: {
        create: {
          sender: "MERCHANT",
          body: cleanMessage,
          authorEmail: finalMerchantEmail,
          createdAt: now,
        },
      },
    },
    include: ticketInclude,
  });

  // Keep the merchant's contact address current for alerts and replies.
  if (contact) {
    await prisma.store.update({ where: { id: storeId }, data: { adminEmail: contact } });
  }

  await queueNotification({
    storeId,
    type: "SUPPORT_TICKET_CREATED",
    title: `Support ticket opened: ${cleanSubject}`,
    body: [
      cleanMessage,
      "",
      `Response target: ${ticketSlaLabel(ticket.planAtSubmission)}.`,
    ].join("\n"),
    recipient: adminEmail,
  });

  // Safe email dispatch - failure will NOT block DB ticket creation
  try {
    await sendEmail({
      to: adminEmail,
      subject: `[New Support Ticket] ${cleanSubject} — ${shopDomain}`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; color: #333;">
          <h2 style="color: #008060; border-bottom: 2px solid #008060; padding-bottom: 8px;">
            New Support Ticket Submitted
          </h2>
          <p><strong>Store Domain:</strong> ${shopDomain}</p>
          <p><strong>Merchant Contact Email:</strong> <a href="mailto:${finalMerchantEmail}">${finalMerchantEmail}</a></p>
          <p><strong>Subscription Plan:</strong> ${(ticket.planAtSubmission || "free").toUpperCase()}</p>
          <p><strong>Inquiry Subject:</strong> ${cleanSubject}</p>
          <div style="background-color: #f4f6f8; padding: 15px; border-radius: 6px; margin-top: 15px;">
            <p style="margin: 0; font-weight: bold; color: #555;">Ticket Message:</p>
            <p style="white-space: pre-wrap; margin-top: 8px;">${cleanMessage}</p>
          </div>
          <p style="margin-top: 20px; font-size: 12px; color: #777;">
            Login to the Admin Control Center to reply to this ticket directly.
          </p>
        </div>
      `,
      text: `New Support Ticket Submitted\nStore: ${shopDomain}\nContact: ${finalMerchantEmail}\nPlan: ${ticket.planAtSubmission}\nSubject: ${cleanSubject}\n\nMessage:\n${cleanMessage}`,
    });
  } catch (emailErr) {
    console.error("[supportEngine] Failed to dispatch admin alert email:", emailErr);
  }

  return { success: true, ticket };
}

/** Append a merchant follow-up, which reopens an answered ticket. */
export async function addMerchantReply({ storeId, ticketId, body }) {
  const text = cleanText(body);
  if (!text) return { success: false, error: "Reply message cannot be empty." };

  const ticket = await prisma.supportTicket.findFirst({
    where: { id: ticketId, storeId },
    include: { store: { select: { shopDomain: true } } },
  });
  if (!ticket) return { success: false, error: "Support ticket not found." };

  const adminEmail = process.env.ADMIN_EMAIL || "sandeepptpss@gmail.com";
  const now = new Date();

  await prisma.supportMessage.create({
    data: {
      ticketId: ticket.id,
      sender: "MERCHANT",
      body: text,
      authorEmail: ticket.merchantEmail,
      createdAt: now,
    },
  });

  const updated = await prisma.supportTicket.update({
    where: { id: ticket.id },
    data: { status: TICKET_STATUS.OPEN, lastMessageAt: now },
    include: ticketInclude,
  });

  await queueNotification({
    storeId,
    type: "SUPPORT_TICKET_REPLY",
    title: `Merchant replied: ${ticket.subject}`,
    body: text,
    recipient: adminEmail,
  });

  // Safe email dispatch
  try {
    await sendEmail({
      to: adminEmail,
      subject: `[Merchant Follow-up] ${ticket.subject} — ${ticket.store?.shopDomain || "Store"}`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; color: #333;">
          <h2 style="color: #008060; border-bottom: 2px solid #008060; padding-bottom: 8px;">
            Merchant Follow-Up Message Received
          </h2>
          <p><strong>Store:</strong> ${ticket.store?.shopDomain || "Unknown Store"}</p>
          <p><strong>Merchant Email:</strong> ${ticket.merchantEmail}</p>
          <p><strong>Ticket Subject:</strong> ${ticket.subject}</p>
          <div style="background-color: #f4f6f8; padding: 15px; border-radius: 6px; margin-top: 15px;">
            <p style="margin: 0; font-weight: bold; color: #555;">Follow-Up Reply:</p>
            <p style="white-space: pre-wrap; margin-top: 8px;">${text}</p>
          </div>
        </div>
      `,
      text: `Merchant Follow-Up\nStore: ${ticket.store?.shopDomain}\nContact: ${ticket.merchantEmail}\nSubject: ${ticket.subject}\n\nMessage:\n${text}`,
    });
  } catch (emailErr) {
    console.error("[supportEngine] Failed to dispatch admin reply email:", emailErr);
  }

  return { success: true, ticket: updated };
}

/** Append an admin reply and mark the ticket answered. */
export async function addAdminReply({ ticketId, body, authorEmail }) {
  const text = cleanText(body);
  if (!text) return { success: false, error: "Reply message cannot be empty." };

  const ticket = await prisma.supportTicket.findUnique({
    where: { id: ticketId },
    include: { store: { select: { shopDomain: true } } },
  });
  if (!ticket) return { success: false, error: "Support ticket not found." };

  const now = new Date();
  const senderEmail = cleanText(authorEmail) || process.env.ADMIN_EMAIL || "sandeepptpss@gmail.com";

  await prisma.supportMessage.create({
    data: {
      ticketId: ticket.id,
      sender: "ADMIN",
      body: text,
      authorEmail: senderEmail,
      createdAt: now,
    },
  });

  const updated = await prisma.supportTicket.update({
    where: { id: ticket.id },
    data: {
      reply: text,
      status: TICKET_STATUS.ANSWERED,
      repliedAt: now,
      lastMessageAt: now,
    },
    include: ticketInclude,
  });

  await queueNotification({
    storeId: ticket.storeId,
    type: "SUPPORT_TICKET_ANSWERED",
    title: `Support replied: ${ticket.subject}`,
    body: text,
    recipient: ticket.merchantEmail,
  });

  // Safe email dispatch
  try {
    await sendEmail({
      to: ticket.merchantEmail,
      subject: `Re: ${ticket.subject} — Support Response`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; color: #333;">
          <h2 style="color: #008060; border-bottom: 2px solid #008060; padding-bottom: 8px;">
            Response From Support Team
          </h2>
          <p>Dear Merchant,</p>
          <p>Our support team (<code>${senderEmail}</code>) has replied to your inquiry: <strong>${ticket.subject}</strong></p>
          <div style="background-color: #f1f8f5; border-left: 4px solid #008060; padding: 15px; margin: 15px 0;">
            <p style="margin: 0; font-weight: bold; color: #008060;">Support Reply:</p>
            <p style="white-space: pre-wrap; margin-top: 8px;">${text}</p>
          </div>
          <p>You can also log in to your Catalog Health Shopify app dashboard to view the full message history or reply directly.</p>
        </div>
      `,
      text: `Support Response\nSubject: Re: ${ticket.subject}\nFrom: ${senderEmail}\n\nMessage:\n${text}`,
    });
  } catch (emailErr) {
    console.error("[supportEngine] Failed to dispatch merchant notification email:", emailErr);
  }

  return { success: true, ticket: updated };
}

/** Explicit status change (admin "Mark resolved" / "Reopen"). */
export async function setTicketStatus({ ticketId, status }) {
  if (!Object.values(TICKET_STATUS).includes(status)) {
    return { success: false, error: `Unknown ticket status "${status}".` };
  }

  const ticket = await prisma.supportTicket.findUnique({ where: { id: ticketId } });
  if (!ticket) return { success: false, error: "Support ticket not found." };

  const updated = await prisma.supportTicket.update({
    where: { id: ticket.id },
    data: { status },
    include: ticketInclude,
  });

  return { success: true, ticket: updated };
}

/** Toggle used by the admin inbox button. */
export async function toggleTicketStatus({ ticketId }) {
  const ticket = await prisma.supportTicket.findUnique({ where: { id: ticketId } });
  if (!ticket) return { success: false, error: "Support ticket not found." };

  return setTicketStatus({
    ticketId,
    status:
      ticket.status === TICKET_STATUS.RESOLVED
        ? TICKET_STATUS.OPEN
        : TICKET_STATUS.RESOLVED,
  });
}

/** One store's conversations, newest activity first. */
export function listStoreTickets(storeId, { take = 10 } = {}) {
  return prisma.supportTicket.findMany({
    where: { storeId },
    include: ticketInclude,
    orderBy: { lastMessageAt: "desc" },
    take,
  });
}

/** Every store's conversations for the admin inbox, tickets needing work first. */
const STATUS_ORDER = { OPEN: 0, ANSWERED: 1, RESOLVED: 2 };

export async function listAllTickets({ take = 50 } = {}) {
  const tickets = await prisma.supportTicket.findMany({
    include: { ...ticketInclude, store: { select: { shopDomain: true, plan: true } } },
    orderBy: { lastMessageAt: "desc" },
    take,
  });

  return tickets.sort(
    (a, b) => (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9),
  );
}

async function queueNotification({ storeId, type, title, body, recipient }) {
  try {
    await prisma.notification.create({
      data: {
        storeId,
        type,
        title: title.slice(0, 255),
        body,
        recipient: recipient || null,
        windowEnd: new Date(),
        status: "PENDING",
      },
    });
  } catch (error) {
    console.error(`[supportEngine] could not queue ${type} notification:`, error);
  }
}
