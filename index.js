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

const MAX_SUGGESTED_CONTACTS = Math.max(1, Number(RULES_CONFIG?.max_suggested_contacts || 2));

/* =========================
   SIMILARITY TUNING
   ========================= */

const RECENT_DAYS = 180;
const OLD_DAYS = 540;
const RERANK_FETCH_LIMIT = 35;
const SIMILAR_TICKETS_TO_RETURN = 3;

const RULE_ANCHOR_BONUS = 18;
const BIGRAM_BONUS = 6;
const RECENCY_BONUS_MAX = 8;

const SHARED_HOST_BONUS = 25;

// If the current ticket has “strong anchors” (rule or URL host),
// then DO NOT show unrelated tickets: penalize candidates that share neither
const ANCHOR_MISS_PENALTY = 80;

// Don’t return “similar” tickets below this score
const MIN_SIMILAR_SCORE = 35;

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
function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}
function confidenceLabel(score) {
  if (score >= 60) return "Likely";
  if (score >= 35) return "Possible";
  return "Low";
}

function parseDateMs(s) {
  const ms = Date.parse(String(s || ""));
  return Number.isFinite(ms) ? ms : null;
}
function daysAgoFromIso(iso) {
  const ms = parseDateMs(iso);
  if (!ms) return null;
  const ageMs = Date.now() - ms;
  return ageMs / (1000 * 60 * 60 * 24);
}

// Tokenize geared for support tickets (includes org-specific noise reducers)
function tokenize(text) {
  const stop = new Set([
    "the","a","an","and","or","to","of","in","on","for","with","at","from","by","is","are","was","were",
    "it","this","that","we","you","i","they","them","us","as","be","been","being","can","could","should",
    "would","will","just","please","thanks","thank",

    "help","urgent","update","issue","question","ticket","request","need","needed","asap",

    "team","hi","hello","regards",
    "scorpion","saleshelp","support",
    "client","clients","customer","customers",
    "account","accounts",
    "looking","trying","figure","proper","way"
  ]);

  return String(text || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .filter(w => w && w.length >= 2 && !stop.has(w));
}

function makeBigrams(tokens) {
  const out = new Set();
  for (let i = 0; i < tokens.length - 1; i++) {
    out.add(`${tokens[i]} ${tokens[i + 1]}`);
  }
  return out;
}

function extractUrlHosts(text) {
  const hosts = new Set();
  const s = String(text || "");
  const re = /https?:\/\/([^\/\s]+)/gi;
  let m;
  while ((m = re.exec(s))) {
    hosts.add(m[1].toLowerCase());
  }
  return hosts;
}

function sharedHostBonus(currentHosts, candidateHosts) {
  if (!currentHosts.size || !candidateHosts.size) return 0;
  let shared = 0;
  for (const h of currentHosts) if (candidateHosts.has(h)) shared++;
  return shared * SHARED_HOST_BONUS;
}

/* =========================
   EXCLUSIONS (from JSON)
   ========================= */

const EXCLUDED_EMAILS = new Set((EXCLUSIONS_CONFIG?.excluded_emails || []).map(normalizeEmail));
const EXCLUDED_INBOXES = new Set((EXCLUSIONS_CONFIG?.excluded_inboxes || []).map(normalizeEmail));
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
  if (r && e === r) return false;
  return true;
}

/* =========================
   RULE MATCHING
   ========================= */

function buildTokenSet(tokens) {
  return new Set((tokens || []).map(t => String(t).toLowerCase()));
}

function itemMatches(textLower, tokenSet, item) {
  const p = String(item || "").toLowerCase().trim();
  if (!p) return false;
  if (p.includes(" ")) return textLower.includes(p);
  return tokenSet.has(p);
}

function groupMatches(textLower, tokenSet, group) {
  const anyList = Array.isArray(group?.any) ? group.any : [];
  const allList = Array.isArray(group?.all) ? group.all : [];

  if (allList.length > 0) return allList.every(it => itemMatches(textLower, tokenSet, it));
  if (anyList.length > 0) return anyList.some(it => itemMatches(textLower, tokenSet, it));
  return false;
}

function ruleMatches(rule, textLower, tokenSet) {
  const notAny = Array.isArray(rule?.notAny) ? rule.notAny : [];
  for (const it of notAny) if (itemMatches(textLower, tokenSet, it)) return false;

  const anyOf = Array.isArray(rule?.anyOf) ? rule.anyOf : [];
  if (anyOf.length === 0) return false;

  return anyOf.some(group => groupMatches(textLower, tokenSet, group));
}

function firedRuleIds(ticketTextLower) {
  const tokenSet = buildTokenSet(tokenize(ticketTextLower));
  const fired = [];
  for (const rule of (RULES_CONFIG?.rules || [])) {
    if (ruleMatches(rule, ticketTextLower, tokenSet)) fired.push(String(rule.id));
  }
  return fired;
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

// Freshdesk search quirk: query must be quoted; page <= 10
async function searchTicketsPagedRawQuery(rawQuery, maxPagesRequested = 10) {
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

/**
 * We prefer "group_id:<id>" ONLY (ignore status).
 * If Freshdesk rejects the query, we fallback to union(status:2..5) and filter by group_id in code.
 */
async function getSalesHelpPoolTickets() {
  // Primary: group-only search (ignore status)
  try {
    const groupOnly = await searchTicketsPagedRawQuery(`group_id:${SALES_HELP_GROUP_ID}`, 10);
    return groupOnly;
  } catch (err) {
    const code = err?.response?.status;
    const msg = err?.response?.data?.errors?.[0]?.message || err.message || "";
    console.log("Group-only search failed, falling back to status union.", { status: code, msg });

    // Fallback: statuses 2-5, then filter group_id in code
    const [open, pending, resolved, closed] = await Promise.all([
      searchTicketsPagedRawQuery("status:2", 10),
      searchTicketsPagedRawQuery("status:3", 10),
      searchTicketsPagedRawQuery("status:4", 10),
      searchTicketsPagedRawQuery("status:5", 10),
    ]);
    return uniqById([...open, ...pending, ...resolved, ...closed]);
  }
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
      // ignore
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
   SIMILARITY SCORING
   ========================= */

function buildIdfMap(candidateDocsTokens) {
  const df = new Map();
  const N = candidateDocsTokens.length || 1;

  for (const tokenSet of candidateDocsTokens) {
    for (const tok of tokenSet) df.set(tok, (df.get(tok) || 0) + 1);
  }

  const idf = new Map();
  for (const [tok, dfi] of df.entries()) {
    const val = Math.log((N + 1) / (dfi + 1)) + 1;
    idf.set(tok, val);
  }
  return idf;
}

function overlapScoreIdf(currentTokenSet, candidateTokenSet, idfMap) {
  let score = 0;
  for (const tok of candidateTokenSet) {
    if (!currentTokenSet.has(tok)) continue;
    score += idfMap.get(tok) || 1;
  }
  return score;
}

function bigramBonus(currentBigrams, candidateTextLower) {
  let bonus = 0;
  for (const bg of currentBigrams) {
    if (candidateTextLower.includes(bg)) bonus += BIGRAM_BONUS;
  }
  return bonus;
}

function recencyBonus(updatedAtIso) {
  const ageDays = daysAgoFromIso(updatedAtIso);
  if (ageDays == null) return 0;

  if (ageDays <= RECENT_DAYS) {
    const frac = (RECENT_DAYS - ageDays) / RECENT_DAYS;
    return frac * RECENCY_BONUS_MAX;
  }
  if (ageDays >= OLD_DAYS) return -RECENCY_BONUS_MAX;

  const frac = (ageDays - RECENT_DAYS) / (OLD_DAYS - RECENT_DAYS);
  return -frac * (RECENCY_BONUS_MAX / 2);
}

function sharedRuleBonus(currentRuleIds, candidateRuleIds) {
  if (!currentRuleIds.length) return 0;
  const cand = new Set(candidateRuleIds || []);
  let shared = 0;
  for (const id of currentRuleIds) if (cand.has(id)) shared++;
  return shared * RULE_ANCHOR_BONUS;
}

/* =========================
   ROUTES
   ========================= */

app.get("/health", (req, res) => res.send("ok"));

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
    similarity: {
      RECENT_DAYS,
      OLD_DAYS,
      RERANK_FETCH_LIMIT,
      RULE_ANCHOR_BONUS,
      BIGRAM_BONUS,
      RECENCY_BONUS_MAX,
      SHARED_HOST_BONUS,
      ANCHOR_MISS_PENALTY,
      MIN_SIMILAR_SCORE
    }
  });
});

app.get("/suggest", async (req, res) => {
  const ticketId = String(req.query.ticketId || "").trim();
  if (!ticketId) return res.status(400).send("Missing ticketId");

  if (!baseURL) return res.status(500).send("Server misconfigured: invalid FRESHDESK_DOMAIN");
  if (!FRESHDESK_API_KEY) return res.status(500).send("Server misconfigured: missing FRESHDESK_API_KEY");
  if (!SALES_HELP_GROUP_ID) return res.status(500).send("Server misconfigured: missing SALES_HELP_GROUP_ID");

  try {
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

    const currentRuleIds = firedRuleIds(ticketTextLower);
    const currentTokenSet = new Set(tokenize(ticketTextLower));
    const currentBigrams = makeBigrams(tokenize(ticketTextLower));
    const currentHosts = extractUrlHosts(ticketText);

    const hasStrongAnchor = currentRuleIds.length > 0 || currentHosts.size > 0;

    /* ---------- Rule-based loop-ins ---------- */
    const ruleBasedLoopIns = buildRuleSuggestions(ticketTextLower, requesterEmail).slice(0, MAX_SUGGESTED_CONTACTS);

    /* ---------- Similar tickets (group-based pool, ignore status) ---------- */

    // Get pool ignoring status (primary: group_id search; fallback: status union)
    const pooledRaw = await getSalesHelpPoolTickets();

    // Always enforce group_id in code too (safety)
    const pooled = uniqById(pooledRaw).filter(t => String(t.group_id) === SALES_HELP_GROUP_ID);

    const candidates = pooled.filter(t => String(t.id) !== ticketId);

    // IDF based on subject corpus (cheap + good enough)
    const candidateSubjectTokenSets = candidates.map(t => new Set(tokenize(t.subject || "")));
    const idfMap = buildIdfMap(candidateSubjectTokenSets);

    // Pass 1: subject-only scoring + anchors + URL boost + recency + anchor-gating penalty
    const scoredPass1 = candidates.map(t => {
      const subj = String(t.subject || "");
      const subjLower = subj.toLowerCase();

      const candTokenSet = new Set(tokenize(subjLower));
      const base = overlapScoreIdf(currentTokenSet, candTokenSet, idfMap);
      const bigram = bigramBonus(currentBigrams, subjLower);
      const rec = recencyBonus(t.updated_at || t.created_at);

      const candRuleIds = firedRuleIds(subjLower);
      const ruleBonus = sharedRuleBonus(currentRuleIds, candRuleIds);

      const candHosts = extractUrlHosts(subj);
      const hostBonus = sharedHostBonus(currentHosts, candHosts);

      const sharesAnchor =
        (currentRuleIds.length > 0 && ruleBonus > 0) ||
        (currentHosts.size > 0 && hostBonus > 0);

      const anchorPenalty = (hasStrongAnchor && !sharesAnchor) ? -ANCHOR_MISS_PENALTY : 0;

      const score1 = base + bigram + rec + ruleBonus + hostBonus + anchorPenalty;

      return { id: t.id, subject: t.subject || "", updated_at: t.updated_at || t.created_at || null, score1 };
    });

    const topForFetch = scoredPass1
      .sort((a, b) => b.score1 - a.score1)
      .slice(0, RERANK_FETCH_LIMIT);

    // Pass 2: fetch full ticket text for rerank
    const reranked = await Promise.all(
      topForFetch.map(async (t) => {
        try {
          const { data } = await fd.get(`/tickets/${t.id}`);
          const fullText = `${data.subject || ""}\n${data.description_text || stripHtml(data.description) || ""}`;
          const fullLower = fullText.toLowerCase();

          const candTokenSet = new Set(tokenize(fullLower));
          const base = overlapScoreIdf(currentTokenSet, candTokenSet, idfMap);
          const bigram = bigramBonus(currentBigrams, fullLower);
          const rec = recencyBonus(data.updated_at || data.created_at);

          const candRuleIds = firedRuleIds(fullLower);
          const ruleBonus = sharedRuleBonus(currentRuleIds, candRuleIds);

          const candHosts = extractUrlHosts(fullText);
          const hostBonus = sharedHostBonus(currentHosts, candHosts);

          const sharesAnchor =
            (currentRuleIds.length > 0 && ruleBonus > 0) ||
            (currentHosts.size > 0 && hostBonus > 0);

          const anchorPenalty = (hasStrongAnchor && !sharesAnchor) ? -ANCHOR_MISS_PENALTY : 0;

          const score = base + bigram + rec + ruleBonus + hostBonus + anchorPenalty;

          return {
            id: t.id,
            subject: data.subject || t.subject,
            score,
            confidence: confidenceLabel(score),
            url: `${freshdeskDomain}/a/tickets/${t.id}`
          };
        } catch {
          const score = t.score1;
          return {
            id: t.id,
            subject: t.subject,
            score,
            confidence: confidenceLabel(score),
            url: `${freshdeskDomain}/a/tickets/${t.id}`
          };
        }
      })
    );

    const similarTickets = reranked
      .sort((a, b) => b.score - a.score)
      .filter(t => t.score >= MIN_SIMILAR_SCORE)
      .slice(0, SIMILAR_TICKETS_TO_RETURN)
      .map(t => ({
        id: t.id,
        subject: t.subject,
        score: Math.round(t.score * 10) / 10,
        confidence: t.confidence,
        url: t.url
      }));

    /* ---------- History/current-loop-in contacts ---------- */
    const historySet = new Map();

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

    // Use top reranked IDs as evidence
    const similarIdsForContacts = reranked
      .sort((a, b) => b.score - a.score)
      .slice(0, 5)
      .map(t => t.id);

    if (similarIdsForContacts.length) {
      const similarData = await Promise.all(
        similarIdsForContacts.map(async (id) => {
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
        sawCurrent: o.sawCurrent
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

    /* ---------- Merge loop-ins (max N) ---------- */
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
      requesterEmail: requesterEmail || null,
      firedRuleIds: currentRuleIds,
      similarTickets,
      ruleBasedLoopIns,
      suggestedExternalContacts: merged,
      message: "Similarity ✅ (ignore status; group-based pool + anchor-gating + URL host boost)",
      poolSize: pooled.length,
      salesHelpCandidateCount: candidates.length
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
      freshdeskData: err.response?.data || null
    });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server listening on ${port}`));
