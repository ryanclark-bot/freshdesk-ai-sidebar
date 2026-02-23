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

function extractEmailsFromText(text) {
  const s = String(text || "");
  const re = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
  const matches = s.match(re) || [];
  return matches.map(e => e.toLowerCase());
}

function addContactHit(map, email, points, reason, ticketId) {
  if (!email) return;
  const key = String(email).toLowerCase();
  if (!map.has(key)) {
    map.set(key, { email: key, score: 0, reasons: {}, tickets: new Set() });
  }
  const obj = map.get(key);
  obj.score += points;
  obj.reasons[reason] = (obj.reasons[reason] || 0) + points;
  if (ticketId != null) obj.tickets.add(String(ticketId));
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
  auth: {
    username: FRESHDESK_API_KEY,
    password: "X",
  },
  timeout: 20000,
});

/**
 * Search quirks in your account:
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

/* ---------------- Sales Help agent email cache ---------------- */

let salesHelpAgentEmailCache = {
  fetchedAtMs: 0,
  emails: new Set(),
};

// 15 minute cache
const AGENT_CACHE_TTL_MS = 15 * 60 * 1000;

async function getSalesHelpAgentEmails() {
  const now = Date.now();
  if (now - salesHelpAgentEmailCache.fetchedAtMs < AGENT_CACHE_TTL_MS && salesHelpAgentEmailCache.emails.size > 0) {
    return salesHelpAgentEmailCache.emails;
  }

  // Pull agents and filter to those that belong to Sales Help group
  // Many Freshdesk accounts include group_ids on agents; if yours doesn’t, we’ll adjust.
  const { data: agents } = await fd.get(`/agents`);

  const emails = new Set();
  const list = Array.isArray(agents) ? agents : [];

  for (const a of list) {
    const agentEmail = String(a?.contact?.email || a?.email || "").toLowerCase();
    const groupIds = Array.isArray(a?.group_ids) ? a.group_ids.map(String) : [];

    if (agentEmail && groupIds.includes(SALES_HELP_GROUP_ID)) {
      emails.add(agentEmail);
    }
  }

  salesHelpAgentEmailCache = { fetchedAtMs: now, emails };
  console.log("Sales Help agent emails cached:", emails.size);

  return emails;
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

    // 1) Read current ticket
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

    // 2) Candidate pool: resolved + closed
    const [resolved, closed] = await Promise.all([
      searchTicketsPaged("status:4", 10),
      searchTicketsPaged("status:5", 10),
    ]);

    const pooled = uniqById([...resolved, ...closed]);

    const candidates = pooled
      .filter(t => String(t.group_id) === SALES_HELP_GROUP_ID)
      .filter(t => String(t.id) !== ticketId);

    // 3) First pass: subject overlap
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

    // 4) Second pass: fetch full ticket + re-score
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

    /* ---------- B) Suggested External Contacts (0–2, only if strong, external = not Sales Help agent) ---------- */

    const salesHelpAgentEmails = await getSalesHelpAgentEmails();

    const contactScores = new Map();
    const topSimilarIds = similarTickets.map(t => t.id);

    const similarData = await Promise.all(
      topSimilarIds.map(async (id) => {
        const [tRes, cRes] = await Promise.all([
          fd.get(`/tickets/${id}`),
          fd.get(`/tickets/${id}/conversations`),
        ]);
        return { ticket: tRes.data, conversations: cRes.data, id };
      })
    );

    for (const item of similarData) {
      const t = item.ticket;

      // Strong signal: cc_emails
      const cc = Array.isArray(t.cc_emails) ? t.cc_emails : [];
      for (const e of cc) {
        const email = String(e || "").toLowerCase();
        if (email) addContactHit(contactScores, email, 4, "cc_email", item.id);
      }

      // Parse emails from conversation bodies
      const convs = Array.isArray(item.conversations) ? item.conversations : [];
      for (const conv of convs) {
        const body = conv?.body_text || stripHtml(conv?.body || "");
        const emails = extractEmailsFromText(body);
        const incoming = conv?.incoming === true;

        for (const email of emails) {
          addContactHit(contactScores, email, incoming ? 3 : 1, incoming ? "inbound_body" : "body", item.id);
        }
      }
    }

    // Filter out Sales Help agent emails (these are "internal" to the group)
    const scored = Array.from(contactScores.values())
      .filter(c => !salesHelpAgentEmails.has(c.email))
      .map(c => ({
        email: c.email,
        score: c.score,
        ticketCount: c.tickets.size,
        reasons: c.reasons,
      }))
      // Strong-only:
      // appears in >=2 similar tickets OR score >= 8
      .filter(c => c.ticketCount >= 2 || c.score >= 8)
      .sort((a, b) => {
        if (b.ticketCount !== a.ticketCount) return b.ticketCount - a.ticketCount;
        return b.score - a.score;
      })
      .slice(0, 2) // MAX 2
      .map(c => ({
        email: c.email,
        confidence:
          c.ticketCount >= 2 ? "High (seen across multiple similar tickets)" :
          c.score >= 12 ? "High" :
          "Medium",
        evidence: { score: c.score, ticketCount: c.ticketCount, reasons: c.reasons },
      }));

    const suggestedExternalContacts = scored; // could be []

    return res.json({
      ticketId,
      subject: ticket.subject,
      similarTickets,
      suggestedExternalContacts,
      message: "A+B MVP ✅ (external = not Sales Help agent)",
      poolSize: pooled.length,
      salesHelpCandidateCount: candidates.length,
      salesHelpAgentEmailCount: salesHelpAgentEmails.size,
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
