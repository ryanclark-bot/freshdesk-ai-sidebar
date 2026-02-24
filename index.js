require("dotenv").config();
const express = require("express");
const axios = require("axios");
const cors = require("cors");

const app = express();
app.use(cors());

/* ---------------- ENV + HELPERS ---------------- */

function sanitizeDomain(raw) {
  if (!raw) return null;
  return String(raw).trim().replace(/\/+$/, "");
}

function buildBaseUrl(domain) {
  if (!domain) return null;
  return `${domain}/api/v2`;
}

function stripHtml(s) {
  return String(s || "").replace(/<[^>]*>/g, " ");
}

function uniqById(tickets) {
  const m = new Map();
  for (const t of tickets) {
    if (t && t.id != null) m.set(String(t.id), t);
  }
  return Array.from(m.values());
}

function tokenize(text) {
  const stop = new Set([
    "the","a","an","and","or","to","of","in","on","for","with","at","from","by","is","are","was","were",
    "it","this","that","we","you","i","they","them","us","as","be","been","being","can","could","should",
    "would","will","just","please","thanks","thank"
  ]);

  return String(text || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .filter(w => w && w.length >= 3 && !stop.has(w));
}

function confidenceLabel(score) {
  if (score >= 12) return "Likely";
  if (score >= 6) return "Possible";
  return "Low";
}

/* ---------------- B FILTERS ---------------- */

// If your Sales Help distro differs, change this one line.
const SALES_HELP_INBOX = "saleshelp@scorpion.co";

const SYSTEM_EMAIL_PATTERNS = [
  /^freshdesk/i,     // freshdeskbcc@..., freshdesk@...
  /^no-?reply/i,
  /^notifications?/i,
];

function isSystemEmail(email) {
  const e = String(email || "").toLowerCase();
  return SYSTEM_EMAIL_PATTERNS.some(re => re.test(e));
}

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function isValidCandidateEmail(email, requesterEmail) {
  const e = normalizeEmail(email);
  const r = normalizeEmail(requesterEmail);

  if (!e) return false;
  if (e === SALES_HELP_INBOX) return false;
  if (isSystemEmail(e)) return false;
  if (r && e === r) return false; // critical: exclude requester/customer
  return true;
}

function addContactHit(map, email, points, reason, ticketId) {
  const e = normalizeEmail(email);
  if (!e) return;

  if (!map.has(e)) {
    map.set(e, {
      email: e,
      score: 0,
      reasons: {},
      tickets: new Set(),
      flags: { sawCurrent: false }
    });
  }
  const obj = map.get(e);
  obj.score += points;
  obj.reasons[reason] = (obj.reasons[reason] || 0) + points;
  if (ticketId != null) obj.tickets.add(String(ticketId));
  if (reason.startsWith("current_")) obj.flags.sawCurrent = true;
}

/* ---------------- ENV ---------------- */

const rawDomain = process.env.FRESHDESK_DOMAIN;
const freshdeskDomain = sanitizeDomain(rawDomain);
const baseURL = buildBaseUrl(freshdeskDomain);

const SALES_HELP_GROUP_ID = String(process.env.SALES_HELP_GROUP_ID || "").trim();
const FRESHDESK_API_KEY = process.env.FRESHDESK_API_KEY;

// Safe debug
console.log("FRESHDESK_DOMAIN raw:", JSON.stringify(rawDomain));
console.log("FRESHDESK_DOMAIN sanitized:", JSON.stringify(freshdeskDomain));
console.log("Freshdesk baseURL:", JSON.stringify(baseURL));
console.log("SALES_HELP_GROUP_ID:", JSON.stringify(SALES_HELP_GROUP_ID));
console.log("Has FRESHDESK_API_KEY:", Boolean(FRESHDESK_API_KEY));

const fd = axios.create({
  baseURL,
  auth: { username: FRESHDESK_API_KEY, password: "X" },
  timeout: 20000,
});

/**
 * Your Freshdesk quirks:
 * - query must be wrapped in double quotes, e.g. query="status:2"
 * - page is allowed, but must be <= 10
 */
async function searchTicketsPaged(rawQuery, maxPagesRequested = 10) {
  const query = `"${rawQuery}"`;
  const all = [];
  const maxPages = Math.min(Math.max(1, Number(maxPagesRequested) || 1), 10);

  for (let page = 1; page <= maxPages; page++) {
    const { data } = await fd.get(`/search/tickets`, { params: { query, page } });
    const results = Array.isArray(data?.results) ? data.results : [];
    all.push(...results);
    if (results.length === 0) break;
  }

  return all;
}

/* ---------------- Requester email resolution ---------------- */

async function getRequesterEmail(ticket, conversationsMaybe) {
  // 1) Try direct fields (vary by account/plan)
  const direct =
    normalizeEmail(ticket?.requester?.email) ||
    normalizeEmail(ticket?.requester_email) ||
    normalizeEmail(ticket?.email);

  if (direct) return direct;

  // 2) Try contacts endpoint by requester_id (if allowed)
  const requesterId = ticket?.requester_id;
  if (requesterId) {
    try {
      const { data } = await fd.get(`/contacts/${requesterId}`);
      const cEmail = normalizeEmail(data?.email);
      if (cEmail) return cEmail;
    } catch {
      // ignore if not permitted
    }
  }

  // 3) Fallback: earliest incoming conversation from_email
  const convs = Array.isArray(conversationsMaybe) ? conversationsMaybe : [];
  const incoming = convs
    .filter(c => c?.incoming === true && c?.from_email)
    .sort((a, b) => (a?.created_at || "").localeCompare(b?.created_at || ""));

  if (incoming.length) return normalizeEmail(incoming[0].from_email);

  return "";
}

/* ---------------- Extract loop-in recipients ---------------- */

function collectLoopInRecipientsFromOutgoing(convs, requesterEmail) {
  const out = new Set();
  const list = Array.isArray(convs) ? convs : [];

  for (const conv of list) {
    const incoming = conv?.incoming === true;
    if (incoming) continue; // only outgoing replies

    const toList = Array.isArray(conv?.to_emails) ? conv.to_emails : [];
    const ccList = Array.isArray(conv?.cc_emails) ? conv.cc_emails : [];
    const bccList = Array.isArray(conv?.bcc_emails) ? conv.bcc_emails : [];

    for (const e of [...toList, ...ccList, ...bccList]) {
      const email = normalizeEmail(e);
      if (isValidCandidateEmail(email, requesterEmail)) out.add(email);
    }
  }

  return Array.from(out);
}

/* ---------------- ROUTES ---------------- */

app.get("/health", (req, res) => res.send("ok"));

app.get("/suggest", async (req, res) => {
  const ticketId = String(req.query.ticketId || "").trim();
  if (!ticketId) return res.status(400).send("Missing ticketId");

  if (!baseURL) return res.status(500).send("Server misconfigured: invalid FRESHDESK_DOMAIN");
  if (!FRESHDESK_API_KEY) return res.status(500).send("Server misconfigured: missing FRESHDESK_API_KEY");
  if (!SALES_HELP_GROUP_ID) return res.status(500).send("Server misconfigured: missing SALES_HELP_GROUP_ID");

  try {
    /* ---------- Read current ticket + conversations ---------- */
    const [{ data: ticket }, { data: currentConvsRaw }] = await Promise.all([
      fd.get(`/tickets/${ticketId}`),
      fd.get(`/tickets/${ticketId}/conversations`),
    ]);

    const currentConvs = Array.isArray(currentConvsRaw) ? currentConvsRaw : [];

    if (String(ticket.group_id) !== SALES_HELP_GROUP_ID) {
      return res.json({ hide: true, reason: "Not Sales Help", group_id: ticket.group_id });
    }

    const requesterEmail = await getRequesterEmail(ticket, currentConvs);

    /* ---------- A) Similar Tickets ---------- */

    const currentText = `${ticket.subject || ""}\n${ticket.description_text || stripHtml(ticket.description) || ""}`;
    const currentTokens = tokenize(currentText);

    const freq = new Map();
    for (const w of currentTokens) freq.set(w, (freq.get(w) || 0) + 1);
    const topWords = new Set(
      Array.from(freq.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 35)
        .map(([w]) => w)
    );

    const [resolved, closed] = await Promise.all([
      searchTicketsPaged("status:4", 10),
      searchTicketsPaged("status:5", 10),
    ]);

    const pooled = uniqById([...resolved, ...closed]);

    const candidates = pooled
      .filter(t => String(t.group_id) === SALES_HELP_GROUP_ID)
      .filter(t => String(t.id) !== ticketId);

    function scoreSubject(subject) {
      const candTokens = tokenize(subject);
      let overlap = 0;
      for (const w of candTokens) if (topWords.has(w)) overlap++;
      return overlap;
    }

    const firstPass = candidates
      .map(t => ({ id: t.id, subject: t.subject || "", score1: scoreSubject(t.subject || "") }))
      .sort((a, b) => b.score1 - a.score1)
      .slice(0, 20);

    const fullTickets = await Promise.all(
      firstPass.map(async (t) => {
        try {
          const { data } = await fd.get(`/tickets/${t.id}`);
          const txt = `${data.subject || ""}\n${data.description_text || stripHtml(data.description) || ""}`;
          return { ...t, fullText: txt };
        } catch {
          return { ...t, fullText: t.subject };
        }
      })
    );

    function scoreFull(text) {
      const candTokens = tokenize(text);
      let overlap = 0;
      for (const w of candTokens) if (topWords.has(w)) overlap++;

      const subj = String(ticket.subject || "").toLowerCase().trim();
      if (subj && String(text).toLowerCase().includes(subj)) overlap += 5;

      return overlap;
    }

    const ranked = fullTickets
      .map(t => {
        const score = scoreFull(t.fullText || t.subject);
        return {
          id: t.id,
          subject: t.subject,
          score,
          confidence: confidenceLabel(score),
          url: `${freshdeskDomain}/a/tickets/${t.id}`,
        };
      })
      .sort((a, b) => b.score - a.score);

    const similarTickets = ranked.slice(0, 3);

    /* ---------- B) Suggested external contacts ---------- */
    // New definition (your clarification):
    // Any TO/CC/BCC on an outgoing reply that is NOT the requester, and NOT system Freshdesk emails.

    const contactScores = new Map();

    // B1) CURRENT ticket loop-ins (highest priority)
    const currentLoopIns = collectLoopInRecipientsFromOutgoing(currentConvs, requesterEmail);
    for (const e of currentLoopIns) {
      addContactHit(contactScores, e, 50, "current_loopin", ticketId); // strong: used on this ticket
    }

    // B2) Similar tickets loop-ins (only if we still need candidates)
    // Use up to top 5 similar tickets for extra evidence, but still cap to 2 final.
    const similarForContacts = ranked.slice(0, 5).map(t => t.id);

    if (contactScores.size < 4 && similarForContacts.length) {
      const similarData = await Promise.all(
        similarForContacts.map(async (id) => {
          const [{ data: t }, { data: convsRaw }] = await Promise.all([
            fd.get(`/tickets/${id}`),
            fd.get(`/tickets/${id}/conversations`),
          ]);
          const convs = Array.isArray(convsRaw) ? convsRaw : [];
          const reqEmail = await getRequesterEmail(t, convs);
          return { id, ticket: t, convs, reqEmail };
        })
      );

      for (const item of similarData) {
        const loopIns = collectLoopInRecipientsFromOutgoing(item.convs, item.reqEmail);

        for (const e of loopIns) {
          // slightly lower than current ticket, but still strong
          addContactHit(contactScores, e, 10, "similar_loopin", item.id);
        }
      }
    }

    // Select up to 2 contacts
    const suggestedExternalContacts = Array.from(contactScores.values())
      .map(c => ({
        email: c.email,
        score: c.score,
        ticketCount: c.tickets.size,
        sawCurrent: c.flags.sawCurrent,
        reasons: c.reasons,
      }))
      .sort((a, b) => {
        const aCur = a.sawCurrent ? 1 : 0;
        const bCur = b.sawCurrent ? 1 : 0;
        if (bCur !== aCur) return bCur - aCur;
        if (b.ticketCount !== a.ticketCount) return b.ticketCount - a.ticketCount;
        return b.score - a.score;
      })
      .slice(0, 2)
      .map(c => ({
        email: c.email,
        confidence: c.sawCurrent ? "High (added on this ticket)" : "High (added on similar tickets)",
        evidence: { score: c.score, ticketCount: c.ticketCount, reasons: c.reasons },
      }));

    return res.json({
      ticketId,
      subject: ticket.subject,
      requesterEmail: requesterEmail || null, // helpful debug; remove later if you want
      similarTickets,
      suggestedExternalContacts,
      message: "A+B MVP ✅ (B = outgoing TO/CC/BCC minus requester/system; includes current ticket)",
      poolSize: pooled.length,
      salesHelpCandidateCount: candidates.length,
    });

  } catch (err) {
    console.error("Suggest error:", err.message);
    if (err.response) {
      console.error("Freshdesk status:", err.response.status);
      console.error("Freshdesk data:", err.response.data);
    }
    const status = err.response?.status || 500;
    return res.status(status).json({
      error: err.message,
      freshdeskStatus: err.response?.status || null,
      freshdeskData: err.response?.data || null,
    });
  }
});

/* ---------------- START ---------------- */

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server listening on ${port}`));
