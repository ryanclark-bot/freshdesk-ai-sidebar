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

const rawDomain = process.env.FRESHDESK_DOMAIN;
const freshdeskDomain = sanitizeDomain(rawDomain);
const baseURL = buildBaseUrl(freshdeskDomain);

const SALES_HELP_GROUP_ID = String(process.env.SALES_HELP_GROUP_ID || "").trim();
const FRESHDESK_API_KEY = process.env.FRESHDESK_API_KEY;

// Safe debug (does NOT print API key)
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

function uniqById(tickets) {
  const m = new Map();
  for (const t of tickets) {
    if (t && t.id != null) m.set(String(t.id), t);
  }
  return Array.from(m.values());
}

/**
 * IMPORTANT for your Freshdesk: the query value must be wrapped in double quotes
 * Example that works for you: query="status:2"
 *
 * This version fetches multiple pages so we actually get enough Sales Help tickets.
 */
async function searchTicketsPaged(rawQuery, pages = 8, perPage = 30) {
  const query = `"${rawQuery}"`;
  const all = [];

  for (let page = 1; page <= pages; page++) {
    const { data } = await fd.get(`/search/tickets`, {
      params: { query, page, per_page: perPage },
    });

    const results = Array.isArray(data?.results) ? data.results : [];
    all.push(...results);

    // If this page returned less than perPage, we likely hit the end.
    if (results.length < perPage) break;
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
    /* ---------- 1) Read current ticket ---------- */
    const { data: ticket } = await fd.get(`/tickets/${ticketId}`);

    if (String(ticket.group_id) !== SALES_HELP_GROUP_ID) {
      return res.json({ hide: true, reason: "Not Sales Help", group_id: ticket.group_id });
    }

    /* ---------- 2) Build keyword set from current ticket ---------- */
    const fullText = `${ticket.subject || ""}\n${ticket.description_text || stripHtml(ticket.description) || ""}`
      .toLowerCase();

    const stop = new Set([
      "the","a","an","and","or","to","of","in","on","for","with","at","from","by","is","are","was","were",
      "it","this","that","we","you","i","they","them","us","as","be","been","being","can","could","should",
      "would","will","just","please","thanks","thank"
    ]);

    const tokens = fullText
      .split(/[^a-z0-9]+/g)
      .filter(w => w && w.length >= 3 && !stop.has(w));

    const freq = new Map();
    for (const w of tokens) freq.set(w, (freq.get(w) || 0) + 1);

    const topWords = new Set(
      Array.from(freq.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 30)
        .map(([w]) => w)
    );

    /* ---------- 3) Candidate pool: resolved + closed (paged) ---------- */
    const [resolved, closed] = await Promise.all([
      searchTicketsPaged("status:4", 10, 30), // up to ~300
      searchTicketsPaged("status:5", 10, 30), // up to ~300
    ]);

    const pooled = uniqById([...resolved, ...closed]);

    /* ---------- 4) Filter to Sales Help + exclude current ticket ---------- */
    const candidates = pooled
      .filter(t => String(t.group_id) === SALES_HELP_GROUP_ID)
      .filter(t => String(t.id) !== ticketId)
      .filter(t => (t.subject || "").trim().length > 0);

    /* ---------- 5) Score similarity (subject overlap, but allow partials) ---------- */
    function scoreTicket(t) {
      const candText = `${t.subject || ""}`.toLowerCase();
      const candTokens = candText.split(/[^a-z0-9]+/g).filter(Boolean);

      let overlap = 0;
      for (const w of candTokens) if (topWords.has(w)) overlap++;

      // small boost if exact phrase from current subject appears
      const subj = (ticket.subject || "").toLowerCase();
      if (subj && candText.includes(subj)) overlap += 5;

      return overlap;
    }

    const similarTickets = candidates
      .map(t => ({
        id: t.id,
        subject: t.subject,
        score: scoreTicket(t),
      }))
      // NOTE: for short tickets like "Acct merger", overlap may be 0
      // so we allow >= 1, but we'll also show top items if candidates exist.
      .sort((a, b) => b.score - a.score)
      .slice(0, 5)
      .map(s => ({
        ...s,
        url: `${freshdeskDomain}/a/tickets/${s.id}`,
      }));

    // If all scores are 0 but we have candidates, still return top 3 as "possible"
    const anyScore = similarTickets.some(t => t.score > 0);
    const finalSimilar = anyScore ? similarTickets.filter(t => t.score > 0) : similarTickets.slice(0, 3);

    return res.json({
      ticketId,
      subject: ticket.subject,
      similarTickets: finalSimilar,
      message: "Similar tickets MVP (paged status 4 + 5 pool) ✅",
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
