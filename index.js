require("dotenv").config();
const express = require("express");
const axios = require("axios");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(cors());

function readJson(filePath) {
  const abs = path.join(__dirname, filePath);
  const raw = fs.readFileSync(abs, "utf8");
  return JSON.parse(raw);
}

let TAG_RULES_CONFIG = [];

try {
  TAG_RULES_CONFIG = readJson("config/tag_rules.json");
  console.log("Loaded config/tag_rules.json");
} catch (e) {
  console.log("WARNING: Could not load config/tag_rules.json; using empty tag rules:", e.message);
}

const POOL_CACHE_TTL_MS = 10 * 60 * 1000;
const TICKET_CACHE_TTL_MS = 60 * 1000;
const CORE_CACHE_TTL_MS = 45 * 1000;
const SIMILAR_CACHE_TTL_MS = 90 * 1000;
const SAME_TAG_CACHE_TTL_MS = 2 * 60 * 1000;
const SIMILAR_TICKETS_TO_RETURN = 3;

let poolCache = { ts: 0, tickets: [] };
let poolInFlight = null;

const ticketCache = new Map();
const coreCache = new Map();
const similarCache = new Map();
const sameTagCache = new Map();

const inflightCore = new Map();
const inflightSimilar = new Map();
const inflightTicket = new Map();

function nowMs() {
  return Date.now();
}

function getCached(map, key, ttlMs) {
  const hit = map.get(key);
  if (!hit) return null;
  if ((nowMs() - hit.ts) > ttlMs) {
    map.delete(key);
    return null;
  }
  return hit.data;
}

function setCached(map, key, data) {
  map.set(key, { ts: nowMs(), data });
}

async function getOrBuildCached({ cacheMap, inflightMap, key, ttlMs, builder }) {
  const cached = getCached(cacheMap, key, ttlMs);
  if (cached) return cached;

  if (inflightMap.has(key)) return inflightMap.get(key);

  const p = (async () => {
    const data = await builder();
    setCached(cacheMap, key, data);
    return data;
  })();

  inflightMap.set(key, p);

  try {
    return await p;
  } finally {
    inflightMap.delete(key);
  }
}

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

function parseDateMs(s) {
  const ms = Date.parse(String(s || ""));
  return Number.isFinite(ms) ? ms : null;
}

function normalizeLoose(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function prepareTagRules(rules) {
  return (rules || []).map((r, idx) => ({
    priority: idx,
    tag: String(r.tag || "").trim(),
    tagNorm: normalizeLoose(r.tag || ""),
    handledBy: String(r.handledBy || "").trim(),
    helpfulLinks: Array.isArray(r.helpfulLinks) ? r.helpfulLinks.filter(Boolean) : [],
    notes: String(r.notes || "").trim()
  })).filter(r => r.tag);
}

const TAG_RULES = prepareTagRules(TAG_RULES_CONFIG);

function findMappedTagRule(ticketTags) {
  const tagNorms = new Set((ticketTags || []).map(t => normalizeLoose(t)).filter(Boolean));
  if (!tagNorms.size) return null;

  for (const rule of TAG_RULES) {
    if (tagNorms.has(rule.tagNorm)) return rule;
  }
  return null;
}

const rawDomain = process.env.FRESHDESK_DOMAIN;
const freshdeskDomain = sanitizeDomain(rawDomain);
const baseURL = buildBaseUrl(freshdeskDomain);

const SALES_HELP_GROUP_ID = String(process.env.SALES_HELP_GROUP_ID || "").trim();
const FRESHDESK_API_KEY = process.env.FRESHDESK_API_KEY;
const CONFIG_TOKEN = String(process.env.CONFIG_TOKEN || "").trim();

console.log("Freshdesk baseURL:", JSON.stringify(baseURL));
console.log("SALES_HELP_GROUP_ID:", JSON.stringify(SALES_HELP_GROUP_ID));
console.log("Has FRESHDESK_API_KEY:", Boolean(FRESHDESK_API_KEY));
console.log("Loaded tag rules:", TAG_RULES.length);

const fd = axios.create({
  baseURL,
  auth: { username: FRESHDESK_API_KEY, password: "X" },
  timeout: 20000
});

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

async function getSalesHelpPoolTicketsCached() {
  const fresh = (Date.now() - poolCache.ts) < POOL_CACHE_TTL_MS;
  if (fresh && Array.isArray(poolCache.tickets) && poolCache.tickets.length) return poolCache.tickets;

  if (poolInFlight) return await poolInFlight;

  poolInFlight = (async () => {
    try {
      const groupOnly = await searchTicketsPagedRawQuery(`group_id:${SALES_HELP_GROUP_ID}`, 10);
      const tickets = uniqById(groupOnly).filter(t => String(t.group_id) === SALES_HELP_GROUP_ID);
      poolCache = { ts: Date.now(), tickets };
      return tickets;
    } catch (err) {
      const [s2, s3, s4, s5] = await Promise.all([
        searchTicketsPagedRawQuery("status:2", 10),
        searchTicketsPagedRawQuery("status:3", 10),
        searchTicketsPagedRawQuery("status:4", 10),
        searchTicketsPagedRawQuery("status:5", 10)
      ]);
      const tickets = uniqById([...s2, ...s3, ...s4, ...s5]).filter(t => String(t.group_id) === SALES_HELP_GROUP_ID);
      poolCache = { ts: Date.now(), tickets };
      return tickets;
    } finally {
      poolInFlight = null;
    }
  })();

  return await poolInFlight;
}

async function getTicketCached(ticketId) {
  return getOrBuildCached({
    cacheMap: ticketCache,
    inflightMap: inflightTicket,
    key: String(ticketId),
    ttlMs: TICKET_CACHE_TTL_MS,
    builder: async () => {
      const { data } = await fd.get(`/tickets/${ticketId}`);
      return data;
    }
  });
}

function to429Error(err) {
  const status = err?.response?.status;
  if (status !== 429) return null;
  const retryAfter = err?.response?.headers?.["retry-after"] || null;
  return { retryAfter };
}

function buildCorePayload(ticket) {
  const tags = Array.isArray(ticket?.tags) ? ticket.tags : [];
  const mappedTagRule = findMappedTagRule(tags);

  if (tags.length > 0 && mappedTagRule) {
    return {
      ticketId: String(ticket.id),
      subject: ticket.subject || "",
      tags,
      matchMode: "tag",
      matchedTag: mappedTagRule.tag,
      suggestedTags: [],
      handledBy: mappedTagRule.handledBy || "",
      helpfulLinks: mappedTagRule.helpfulLinks.map(url => ({ label: url, url })),
      processNotes: mappedTagRule.notes ? [mappedTagRule.notes] : [],
      hierarchyConfidence: "High (mapped tag)",
      suggestedExternalContacts: [],
      message: "Tag mode ✅"
    };
  }

  if (tags.length > 0 && !mappedTagRule) {
    return {
      ticketId: String(ticket.id),
      subject: ticket.subject || "",
      tags,
      matchMode: "tag_unmapped",
      matchedTag: null,
      suggestedTags: [],
      handledBy: "",
      helpfulLinks: [],
      processNotes: [],
      hierarchyConfidence: "Tag present (unmapped)",
      suggestedExternalContacts: [],
      message: "Tag present ✅ (unmapped)"
    };
  }

  // NO TAG = NO INFERENCE
  return {
    ticketId: String(ticket.id),
    subject: ticket.subject || "",
    tags: [],
    matchMode: "no_tag",
    matchedTag: null,
    suggestedTags: [],
    handledBy: "",
    helpfulLinks: [],
    processNotes: [],
    hierarchyConfidence: "No tag applied",
    suggestedExternalContacts: [],
    message: "No tag applied ✅"
  };
}

async function findRecentSameTagTickets(currentTicketId, tagToMatch, domainForUrl) {
  const tagKey = normalizeLoose(tagToMatch);

  const cached = getCached(sameTagCache, tagKey, SAME_TAG_CACHE_TTL_MS);
  if (cached) {
    return cached
      .filter(t => String(t.id) !== String(currentTicketId))
      .slice(0, SIMILAR_TICKETS_TO_RETURN);
  }

  const pool = await getSalesHelpPoolTicketsCached();
  const candidates = pool.sort((a, b) => {
    const aMs = parseDateMs(a.updated_at || a.created_at) || 0;
    const bMs = parseDateMs(b.updated_at || b.created_at) || 0;
    return bMs - aMs;
  });

  const found = [];
  let inspected = 0;

  for (const t of candidates) {
    if (found.length >= 8) break;
    if (inspected >= 120) break;
    inspected += 1;

    try {
      const data = await getTicketCached(t.id);
      const ticketTags = Array.isArray(data?.tags) ? data.tags : [];
      const tagNorms = new Set(ticketTags.map(normalizeLoose));

      if (!tagNorms.has(tagKey)) continue;

      found.push({
        id: data.id,
        subject: data.subject || "",
        score: null,
        confidence: "Same tag",
        url: `${domainForUrl}/a/tickets/${data.id}`
      });
    } catch {
      // skip quietly
    }
  }

  setCached(sameTagCache, tagKey, found);

  return found
    .filter(t => String(t.id) !== String(currentTicketId))
    .slice(0, SIMILAR_TICKETS_TO_RETURN);
}

async function buildCoreResponse(ticketId) {
  return getOrBuildCached({
    cacheMap: coreCache,
    inflightMap: inflightCore,
    key: String(ticketId),
    ttlMs: CORE_CACHE_TTL_MS,
    builder: async () => {
      const ticket = await getTicketCached(ticketId);

      if (String(ticket.group_id) !== SALES_HELP_GROUP_ID) {
        return { hide: true, reason: "Not Sales Help", group_id: ticket.group_id };
      }

      return buildCorePayload(ticket);
    }
  });
}

async function buildSimilarResponse(ticketId) {
  return getOrBuildCached({
    cacheMap: similarCache,
    inflightMap: inflightSimilar,
    key: `route:${ticketId}`,
    ttlMs: SIMILAR_CACHE_TTL_MS,
    builder: async () => {
      const ticket = await getTicketCached(ticketId);

      if (String(ticket.group_id) !== SALES_HELP_GROUP_ID) {
        return { hide: true, reason: "Not Sales Help", group_id: ticket.group_id };
      }

      const tags = Array.isArray(ticket?.tags) ? ticket.tags : [];
      const mappedTagRule = findMappedTagRule(tags);

      if (tags.length > 0 && mappedTagRule) {
        const sameTagTickets = await findRecentSameTagTickets(ticketId, mappedTagRule.tag, freshdeskDomain);
        return {
          ticketId: String(ticket.id),
          similarTickets: sameTagTickets
        };
      }

      return {
        ticketId: String(ticket.id),
        similarTickets: []
      };
    }
  });
}

app.get("/health", (req, res) => res.send("ok"));

app.get("/config", (req, res) => {
  const token = String(req.query.token || "");
  if (!CONFIG_TOKEN || token !== CONFIG_TOKEN) {
    return res.status(403).json({ error: "Forbidden" });
  }
  return res.json({
    tag_rules_loaded: TAG_RULES.map(r => r.tag),
    cache: {
      POOL_CACHE_TTL_MS,
      TICKET_CACHE_TTL_MS,
      CORE_CACHE_TTL_MS,
      SIMILAR_CACHE_TTL_MS,
      SAME_TAG_CACHE_TTL_MS
    }
  });
});

app.get("/suggest_core", async (req, res) => {
  const ticketId = String(req.query.ticketId || "").trim();
  if (!ticketId) return res.status(400).send("Missing ticketId");

  if (!baseURL) return res.status(500).send("Server misconfigured: invalid FRESHDESK_DOMAIN");
  if (!FRESHDESK_API_KEY) return res.status(500).send("Server misconfigured: missing FRESHDESK_API_KEY");
  if (!SALES_HELP_GROUP_ID) return res.status(500).send("Server misconfigured: missing SALES_HELP_GROUP_ID");

  try {
    const data = await buildCoreResponse(ticketId);
    return res.json(data);
  } catch (err) {
    const rl = to429Error(err);
    if (rl) {
      return res.status(429).json({
        error: "Freshdesk rate limit (429). Wait a bit and retry.",
        retryAfter: rl.retryAfter || null
      });
    }
    return res.status(err?.response?.status || 500).json({
      error: err.message || String(err),
      freshdeskStatus: err.response?.status || null,
      freshdeskData: err.response?.data || null
    });
  }
});

app.get("/suggest_similar", async (req, res) => {
  const ticketId = String(req.query.ticketId || "").trim();
  if (!ticketId) return res.status(400).send("Missing ticketId");

  if (!baseURL) return res.status(500).send("Server misconfigured: invalid FRESHDESK_DOMAIN");
  if (!FRESHDESK_API_KEY) return res.status(500).send("Server misconfigured: missing FRESHDESK_API_KEY");
  if (!SALES_HELP_GROUP_ID) return res.status(500).send("Server misconfigured: missing SALES_HELP_GROUP_ID");

  try {
    const data = await buildSimilarResponse(ticketId);
    return res.json(data);
  } catch (err) {
    const rl = to429Error(err);
    if (rl) {
      return res.status(429).json({
        error: "Freshdesk rate limit (429). Wait a bit and retry.",
        retryAfter: rl.retryAfter || null
      });
    }
    return res.status(err?.response?.status || 500).json({
      error: err.message || String(err),
      freshdeskStatus: err.response?.status || null,
      freshdeskData: err.response?.data || null
    });
  }
});

app.get("/suggest", async (req, res) => {
  const ticketId = String(req.query.ticketId || "").trim();
  if (!ticketId) return res.status(400).send("Missing ticketId");

  try {
    const [core, similar] = await Promise.all([
      buildCoreResponse(ticketId),
      buildSimilarResponse(ticketId)
    ]);

    if (core?.hide) return res.json(core);

    return res.json({
      ...core,
      similarTickets: Array.isArray(similar?.similarTickets) ? similar.similarTickets : []
    });
  } catch (err) {
    const rl = to429Error(err);
    if (rl) {
      return res.status(429).json({
        error: "Freshdesk rate limit (429). Wait a bit and retry.",
        retryAfter: rl.retryAfter || null
      });
    }
    return res.status(err?.response?.status || 500).json({
      error: err.message || String(err),
      freshdeskStatus: err.response?.status || null,
      freshdeskData: err.response?.data || null
    });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server listening on ${port}`));
