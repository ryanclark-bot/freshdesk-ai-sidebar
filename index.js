require("dotenv").config();
const express = require("express");
const axios = require("axios");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(cors());

/* =========================
   LOAD CONFIG FILES
   ========================= */

function readJson(filePath) {
  const abs = path.join(__dirname, filePath);
  const raw = fs.readFileSync(abs, "utf8");
  return JSON.parse(raw);
}

// Defaults (in case config files are missing/malformed)
let RULES_CONFIG = { max_suggested_contacts: 2, rules: [] };
let EXCLUSIONS_CONFIG = {
  excluded_emails: [],
  excluded_inboxes: ["saleshelp@scorpion.co"],
  system_email_prefixes: ["freshdesk", "no-reply", "noreply", "notification", "notifications"],
};

try {
  RULES_CONFIG = readJson("config/rules.json");
  console.log("Loaded config/rules.json");
} catch (e) {
  console.log("WARNING: Could not load config/rules.json; using defaults:", e.message);
}

try {
  EXCLUSIONS_CONFIG = readJson("config/excluded_emails.json");
  console.log("Loaded config/excluded_emails.json");
} catch (e) {
  console.log("WARNING: Could not load config/excluded_emails.json; using defaults:", e.message);
}

const MAX_SUGGESTED_CONTACTS = Math.max(
  1,
  Number(RULES_CONFIG?.max_suggested_contacts || 2)
);

/* =========================
   HELPERS
   ========================= */

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
  for (const t of tickets) if (t && t.id != null) m.set(String(t.id), t);
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
    .filter(w => w && w.length >= 2 && !stop.has(w));
}

function confidenceLabel(score) {
  if (score >= 12) return "Likely";
  if (score >= 6) return "Possible";
  return "Low";
}

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

/* =========================
   EXCLUSIONS (from JSON)
   ========================= */

const EXCLUDED_EMAILS = new Set(
  (EXCLUSIONS_CONFIG?.excluded_emails || []).map(normalizeEmail)
);

const EXCLUDED_INBOXES = new Set(
  (EXCLUSIONS_CONFIG?.excluded_inboxes || []).map(normalizeEmail)
);

const SYSTEM_PREFIXES = (EXCLUSIONS_CONFIG?.system_email_prefixes || [])
  .map(p => String(p || "").toLowerCase())
  .filter(Boolean);

function isSystemEmail(email) {
  const e = normalizeEmail(email);
  return SYSTEM_PREFIXES.some(prefix => e.startsWith(prefix));
}

function isExcluded(email) {
  const e = normalizeEmail(email);
  return EXCLUDED_EMAILS.has(e) || EXCLUDED_INBOXES.has(e) || isSystemEmail(e);
}

function isValidCandidateEmail(email, requesterEmail) {
  const e = normalizeEmail(email);
  const r = normalizeEmail(requesterEmail);

  if (!e) return false;
  if (isExcluded(e)) return false;
  if (r && e === r) return false; // exclude requester/customer
  return true;
}

/* =========================
   RULE MATCHING (order-independent)
   ========================= */

function buildTokenSet(tokens) {
  return new Set((tokens || []).map(t => String(t).toLowerCase()));
}

function itemMatches(textLower, tokenSet, item) {
  const p = String(item || "").toLowerCase().trim();
  if (!p) return false;

  // phrase match
  if (p.includes(" ")) return textLower.includes(p);

  // token match
  return tokenSet.has(p);
}

function groupMatches(textLower, tokenSet, group) {
  const anyList = Array.isArray(group?.any) ? group.any : [];
  const allList = Array.isArray(group?.all) ? group.all : [];

  if (allList.length > 0) {
    return allList.every(it => itemMatches(textLower, tokenSet, it));
  }
  if (anyList.length > 0) {
    return anyList.some(it => itemMatches(textLower, tokenSet, it));
  }
  return false;
}

function ruleMatches(rule, textLower, tokenSet) {
  const notAny = Array.isArray(rule?.notAny) ? rule.notAny : [];
  for (const it of notAny) {
    if (itemMatches(textLower, tokenSet, it)) return false;
  }

  const anyOf = Array.isArray(rule?.anyOf) ? rule.anyOf : [];
  if (anyOf.length === 0) return false;

  return anyOf.some(group => groupMatches(textLower, tokenSet, group));
}

function buildRuleSuggestions(ticketTextLower, requesterEmail) {
  const tokenSet = buildTokenSet(tokenize(ticketTextLower));

  const suggestions = [];
  for (const rule of (RULES_CONFIG?.rules || [])) {
    if (!ruleMatches(rule, ticketTextLower, tokenSet)) continue;

    for (const s of (rule.suggest || [])) {
      const email = normalizeEmail(s.email);
      if (!email) continue;
      if (!isValidCandidateEmail(email, requesterEmail)) continue;

      suggestions.push({
        email,
        confidence: "High (keyword rule)",
        reason: `Rule match: ${rule.id}`,
        ruleId: rule.id
      });
    }
  }

  // dedupe by email
  const seen = new Set();
  return suggestions.filter(s => (seen.has(s.email) ? false : (seen.add(s.email), true)));
}

/* =========================
   FRESHDESK SETUP
   ========================= */

const rawDomain = process.env.FRESHDESK_DOMAIN;
const freshdeskDomain = sanitizeDomain(rawDomain);
const baseURL = buildBaseUrl(freshdeskDomain);

const SALES_HELP_GROUP_ID = String(process.env.SALES_HELP_GROUP_ID || "").trim();
const FRESHDESK_API_KEY = process.env.FRESHDESK_API_KEY;
const CONFIG_TOKEN = String(process.env.CONFIG_TOKEN || "").trim();

console.log("FRESHDESK_DOMAIN sanitized:", JSON.stringify(freshdeskDomain));
console.log("Freshdesk baseURL:", JSON.stringify(baseURL));
console.log("SALES_HELP_GROUP_ID:", JSON.stringify(SALES_HELP_GROUP_ID));
console.log("Has FRESHDESK_API_KEY:", Boolean(FRESHDESK_API_KEY));
console.log("Loaded excluded emails:", EXCLUDED_EMAILS.size);
console.log("Loaded rules:", (RULES_CONFIG?.rules || []).length);

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

/* =========================
   REQUESTER EMAIL RESOLUTION
   ========================= */

async function getRequesterEmail(ticket, conversationsMaybe) {
  const direct =
    normalizeEmail(ticket?.requester?.email) ||
    normalizeEmail(ticket?.requester_email) ||
    normalizeEmail(ticket?.email);

  if (direct) return direct;

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

  const convs = Array.isArray(conversationsMaybe) ? conversationsMaybe : [];
  const incoming = convs
    .filter(c => c?.incoming === true && c?.from_email)
    .sort((a, b) => (a?.created_at || "").localeCompare(b?.created_at || ""));

  if (incoming.length) return normalizeEmail(incoming[0].from_email);
  return "";
}

/* =========================
   LOOP-IN EXTRACTION
   ========================= */

function collectLoopInRecipientsFromOutgoing(convs, requesterEmail) {
  const out = new Set();
  const list = Array.isArray(convs) ? convs : [];

  for (const conv of list) {
    if (conv?.incoming === true) continue;

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

/* =========================
   ROUTES
   ========================= */

app.get("/health", (req, res) => res.send("ok"));

/**
 * Protected debug endpoint
 * Usage: /config?token=YOUR_CONFIG_TOKEN
 */
app.get("/config", (req, res) => {
  const token = String(req.query.token || "");
  if (!CONFIG_TOKEN || token !== CONFIG_TOKEN) {
    return res.status(403).json({ error: "Forbidden" });
  }

  return res.json({
    max_suggested_contacts: MAX_SUGGESTED_CONTACTS,
    excluded_emails_count: EXCLUDED_EMAILS.size,
    excluded_inboxes: Array.from(EXCLUDED_INBOXES),
    system_prefixes: SYSTEM_PREFIXES,
    rules_loaded: (RULES_CONFIG?.rules || []).map(r => r.id),
  });
});

app.get("/suggest", async (req, res) => {
  const ticketId = String(req.query.ticketId || "").trim();
  if (!ticketId) return res.status(400).send("Missing ticketId");

  if (!baseURL) return res.status(500).send("Server misconfigured: invalid FRESHDESK_DOMAIN");
  if (!FRESHDESK_API_KEY) return res.status(500).send("Server misconfigured: missing FRESHDESK_API_KEY");
  if (!SALES_HELP_GROUP_ID) return res.status(500).send("Server misconfigured: missing SALES_HELP_GROUP_ID");

  try {
    // Read current ticket + conversations
    const [{ data: ticket }, { data: currentConvsRaw }] = await Promise.all([
      fd.get(`/tickets/${ticketId}`),
      fd.get(`/tickets/${ticketId}/conversations`),
    ]);
    const currentConvs = Array.isArray(currentConvsRaw) ? currentConvsRaw : [];

    if (String(ticket.group_id) !== SALES_HELP_GROUP_ID) {
      return res.json({ hide: true, reason: "Not Sales Help", group_id: ticket.group_id });
    }

    const requesterEmail = await getRequesterEmail(ticket, currentConvs);

    const ticketText = `${ticket.subject || ""}\n${ticket.description_text || stripHtml(ticket.description) || ""}`;
    const ticketTextLower = ticketText.toLowerCase();

    /* ---------- Rule-based loop-ins ---------- */
    const ruleBasedLoopIns = buildRuleSuggestions(ticketTextLower, requesterEmail)
      .slice(0, MAX_SUGGESTED_CONTACTS);

    /* ---------- Similar tickets ---------- */
    const currentTokens = tokenize(ticketTextLower);
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
        const s = scoreFull(t.fullText || t.subject);
        return {
          id: t.id,
          subject: t.subject,
          score: s,
          confidence: confidenceLabel(s),
          url: `${freshdeskDomain}/a/tickets/${t.id}`,
        };
      })
      .sort((a, b) => b.score - a.score);

    const similarTickets = ranked.slice(0, 3);

    /* ---------- History/current-loop-in contacts ---------- */
    // NOTE: we keep this simple: current ticket outgoing recipients minus requester/system/excludes,
    // plus similar ticket recipients (top 5) if needed.
    const historySet = new Map(); // email -> {score, ticketCount, sawCurrent}

    function bump(email, points, sawCurrent, ticketRef) {
      const e = normalizeEmail(email);
      if (!isValidCandidateEmail(e, requesterEmail)) return;
      if (!historySet.has(e)) historySet.set(e, { email: e, score: 0, tickets: new Set(), sawCurrent: false });
      const obj = historySet.get(e);
      obj.score += points;
      if (ticketRef) obj.tickets.add(String(ticketRef));
      if (sawCurrent) obj.sawCurrent = true;
    }

    const currentLoopIns = collectLoopInRecipientsFromOutgoing(currentConvs, requesterEmail);
    for (const e of currentLoopIns) bump(e, 50, true, ticketId);

    const similarForContacts = ranked.slice(0, 5).map(t => t.id);
    if (similarForContacts.length) {
      const similarData = await Promise.all(
        similarForContacts.map(async (id) => {
          const [{ data: t }, { data: convsRaw }] = await Promise.all([
            fd.get(`/tickets/${id}`),
            fd.get(`/tickets/${id}/conversations`),
          ]);
          const convs = Array.isArray(convsRaw) ? convsRaw : [];
          const reqEmail = await getRequesterEmail(t, convs);
          return { id, convs, reqEmail };
        })
      );

      for (const item of similarData) {
        const loopIns = collectLoopInRecipientsFromOutgoing(item.convs, item.reqEmail);
        for (const e of loopIns) bump(e, 10, false, item.id);
      }
    }

    const historyBased = Array.from(historySet.values())
      .map(o => ({
        email: o.email,
        score: o.score,
        ticketCount: o.tickets.size,
        sawCurrent: o.sawCurrent,
      }))
      .sort((a, b) => {
        const aCur = a.sawCurrent ? 1 : 0;
        const bCur = b.sawCurrent ? 1 : 0;
        if (bCur !== aCur) return bCur - aCur;
        if (b.ticketCount !== a.ticketCount) return b.ticketCount - a.ticketCount;
        return b.score - a.score;
      })
      .map(o => ({
        email: o.email,
        confidence: o.sawCurrent ? "High (added on this ticket)" : "High (added on similar tickets)",
        evidence: { score: o.score, ticketCount: o.ticketCount }
      }));

    /* ---------- Merge rule-based + history-based (max N) ---------- */
    const merged = [];
    const seen = new Set();

    for (const r of ruleBasedLoopIns) {
      if (merged.length >= MAX_SUGGESTED_CONTACTS) break;
      if (!seen.has(r.email)) {
        seen.add(r.email);
        merged.push({ email: r.email, confidence: r.confidence, reason: r.reason, source: "rule" });
      }
    }

    for (const h of historyBased) {
      if (merged.length >= MAX_SUGGESTED_CONTACTS) break;
      if (!seen.has(h.email)) {
        seen.add(h.email);
        merged.push({ email: h.email, confidence: h.confidence, source: "history", evidence: h.evidence });
      }
    }

    return res.json({
      ticketId,
      subject: ticket.subject,
      requesterEmail: requesterEmail || null, // debug; remove later if desired
      similarTickets,
      ruleBasedLoopIns,
      suggestedExternalContacts: merged,
      message: "Config-driven V1 ✅ (rules.json + excluded_emails.json)",
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

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server listening on ${port}`));
