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

const rawDomain = process.env.FRESHDESK_DOMAIN;
const freshdeskDomain = sanitizeDomain(rawDomain);
const baseURL = buildBaseUrl(freshdeskDomain);

const SALES_HELP_GROUP_ID = String(process.env.SALES_HELP_GROUP_ID || "").trim();
const FRESHDESK_API_KEY = process.env.FRESHDESK_API_KEY;

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

/* ---------------- ROUTES ---------------- */

app.get("/health", (req, res) => res.send("ok"));

app.get("/suggest", async (req, res) => {
  const ticketId = String(req.query.ticketId || "").trim();
  if (!ticketId) return res.status(400).send("Missing ticketId");

  if (!baseURL) return res.status(500).send("Server misconfigured: invalid FRESHDESK_DOMAIN");
  if (!FRESHDESK_API_KEY) return res.status(500).send("Server misconfigured: missing FRESHDESK_API_KEY");
  if (!SALES_HELP_GROUP_ID) return res.status(500).send("Server misconfigured: missing SALES_HELP_GROUP_ID");

  try {
    /* ---------- 1. Read current ticket ---------- */
    const { data: ticket } = await fd.get(`/tickets/${ticketId}`);

    if (String(ticket.group_id) !== SALES_HELP_GROUP_ID) {
      return res.json({ hide: true, reason: "Not Sales Help", group_id: ticket.group_id });
    }

    /* ---------- 2. Build keyword set ---------- */
    const text = `${ticket.subject || ""}\n${ticket.description_text || ticket.description || ""}`
      .replace(/<[^>]*>/g, " ")
      .toLowerCase();

    const stop = new Set([
      "the","a","an","and","or","to","of","in","on","for","with","at","from","by","is","are","was","were",
      "it","this","that","we","you","i","they","them","us","as","be","been","being","can","could","should",
      "would","will","just","please","thanks","thank"
    ]);

    const tokens = text
      .split(/[^a-z0-9]+/g)
      .filter(w => w && w.length >= 3 && !stop.has(w));

    const freq = new Map();
    for (const w of tokens) freq.set(w, (freq.get(w) || 0) + 1);

    const topWords = new Set(
      Array.from(freq.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 25)
        .map(([w]) => w)
    );

    /* ---------- 3. Pull resolved/closed pool ---------- */
    const { data: search } = await fd.get(`/search/tickets`, {
      params: { query: "status:4 OR status:5" },
    });

    const results = Array.isArray(search?.results) ? search.results : [];

    const candidates = results
      .filter(t => String(t.group_id) === SALES_HELP_GROUP_ID)
      .filter(t => String(t.id) !== ticketId)
      .filter(t => (t.subject || "").trim().length > 0);

    /* ---------- 4. Score similarity ---------- */
    function scoreTicket(t) {
      const candText = `${t.subject || ""}`.toLowerCase();
      const candTokens = candText.split(/[^a-z0-9]+/g).filter(Boolean);

      let overlap = 0;
      for (const w of candTokens) if (topWords.has(w)) overlap++;

      return overlap;
    }

    const similarTickets = candidates
      .map(t => ({
        id: t.id,
        subject: t.subject,
        score: scoreTicket(t),
      }))
      .filter(x => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 5)
      .map(s => ({
        ...s,
        url: `${freshdeskDomain}/a/tickets/${s.id}`,
      }));

    /* ---------- 5. Return ---------- */
    return res.json({
      ticketId,
      subject: ticket.subject,
      similarTickets,
      message: "Similar tickets MVP (keyword overlap) ✅",
    });

  } catch (err) {
    console.error("Suggest error:", err.message);
    if (err.response) {
      console.error("Freshdesk status:", err.response.status);
      console.error("Freshdesk data:", err.response.data);
    }
    return res.status(500).send("Error");
  }
});

/* ---------------- START ---------------- */

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server listening on ${port}`));
