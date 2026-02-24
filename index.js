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

function addContactHit(map, email, points, reason, ticketId) {
  if (!email) return;
  const key = String(email).toLowerCase();
  if (!map.has(key)) {
    map.set(key, {
      email: key,
      score: 0,
      reasons: {},
      tickets: new Set(),
      flags: { sawCc: false, sawBcc: false }
    });
  }
  const obj = map.get(key);
  obj.score += points;
  obj.reasons[reason] = (obj.reasons[reason] || 0) + points;
  if (ticketId != null) obj.tickets.add(String(ticketId));
  if (reason === "cc_email") obj.flags.sawCc = true;
  if (reason === "bcc_email") obj.flags.sawBcc = true;
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

/* ---------------- ROUTES ---------------- */

app.get("/health", (req, res) => res.send("ok"));

app.get("/suggest", async (req, res) => {
  const ticketId = String(req.query.ticketId || "").trim();
  if (!ticketId) return res.status(400).send("Missing ticketId");

  if (!baseURL) return res.status(500).send("Server misconfigured: invalid FRESHDESK_DOMAIN");
  if (!FRESHDESK_API_KEY) return res.status(500).send("Server misconfigured: missing FRESHDESK_API_KEY");
  if (!SALES_HELP_GROUP_ID) return res.status(500).send("Server misconfigured: missing SALES_HELP_GROUP_ID");

  try {
    /* ---------- A) Similar Tickets ---------- */

    const { data: ticket } = await fd.get(`/tickets/${ticketId}`);

    if (String(ticket.group_id) !== SALES_HELP_GROUP_ID) {
      return res.json({ hide: true, reason: "Not Sales Help", group_id: ticket.group_id });
    }

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

    /* ---------- B) Suggested External Contacts (0–2) ---------- */
    // IMPORTANT FIXES:
    // - DO NOT use to_emails (contains requester/customer like Tim)
    // - ONLY use cc_emails + bcc_emails on outgoing messages + ticket-level cc_emails
    // - Filter out Freshdesk system emails (freshdesk*), and the Sales Help mailbox itself

    const SYSTEM_EMAIL_PATTERNS = [
      /^freshdesk/i,                 // freshdeskbcc@..., freshdesk@...
      /^no-?reply/i,
      /^notifications?/i,
    ];

    const SALES_HELP_INBOX = "saleshelp@scorpion.co"; // adjust if needed

    function isSystemEmail(email) {
      const e = String(email || "").toLowerCase();
      return SYSTEM_EMAIL_PATTERNS.some(re => re.test(e));
    }

    const contactScores = new Map();

    // (Optional) use up to 5 similar tickets for better contact evidence, still display top 3 for A
    const similarForContacts = ranked.slice(0, 5).map(t => t.id);

    const similarData = await Promise.all(
      similarForContacts.map(async (id) => {
        const [tRes, cRes] = await Promise.all([
          fd.get(`/tickets/${id}`),
          fd.get(`/tickets/${id}/conversations`),
        ]);
        return { ticket: tRes.data, conversations: cRes.data, id };
      })
    );

    for (const item of similarData) {
      const t = item.ticket;

      // Ticket-level CCs
      const ticketCC = Array.isArray(t.cc_emails) ? t.cc_emails : [];
      for (const e of ticketCC) {
        const email = String(e || "").toLowerCase();
        if (!email) continue;
        if (email === SALES_HELP_INBOX) continue;
        if (isSystemEmail(email)) continue;
        addContactHit(contactScores, email, 8, "cc_email", item.id); // strong signal
      }

      const convs = Array.isArray(item.conversations) ? item.conversations : [];
      for (const conv of convs) {
        const incoming = conv?.incoming === true;
        if (incoming) continue; // only outgoing

        const ccList = Array.isArray(conv?.cc_emails) ? conv.cc_emails : [];
        const bccList = Array.isArray(conv?.bcc_emails) ? conv.bcc_emails : [];

        for (const e of ccList) {
          const email = String(e || "").toLowerCase();
          if (!email) continue;
          if (email === SALES_HELP_INBOX) continue;
          if (isSystemEmail(email)) continue;
          addContactHit(contactScores, email, 8, "cc_email", item.id);
        }

        for (const e of bccList) {
          const email = String(e || "").toLowerCase();
          if (!email) continue;
          if (email === SALES_HELP_INBOX) continue;
          if (isSystemEmail(email)) continue;
          addContactHit(contactScores, email, 8, "bcc_email", item.id);
        }
      }
    }

    // Strong-only: must be CC/BCC at least once
    const suggestedExternalContacts = Array.from(contactScores.values())
      .map(c => ({
        email: c.email,
        score: c.score,
        ticketCount: c.tickets.size,
        sawLoopIn: (c.flags.sawCc || c.flags.sawBcc),
        reasons: c.reasons,
      }))
      .filter(c => c.sawLoopIn)
      .sort((a, b) => {
        if (b.ticketCount !== a.ticketCount) return b.ticketCount - a.ticketCount;
        return b.score - a.score;
      })
      .slice(0, 2)
      .map(c => ({
        email: c.email,
        confidence: c.ticketCount >= 2
          ? "High (looped in across multiple similar tickets)"
          : "High (explicitly looped in on a similar ticket)",
        evidence: { score: c.score, ticketCount: c.ticketCount, reasons: c.reasons },
      }));

    return res.json({
      ticketId,
      subject: ticket.subject,
      similarTickets,
      suggestedExternalContacts,
      message: "A+B MVP ✅ (B uses only outgoing CC/BCC + ticket CC; excludes system + requester)",
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
