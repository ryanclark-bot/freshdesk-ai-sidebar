/**
 * index.js — Freshdesk AI Sidebar (MVP plumbing)
 * Deploy on Railway. Exposes:
 *   GET /health
 *   GET /suggest?ticketId=12345
 *
 * Notes:
 * - Keeps Freshdesk API key server-side (Railway Variables)
 * - Validates ticket is in Sales Help group
 * - Includes debug logs to troubleshoot "Invalid URL" / env var issues
 */

require("dotenv").config();
const express = require("express");
const axios = require("axios");
const cors = require("cors");

const app = express();
app.use(cors());

// --- Helpers ---
function sanitizeDomain(raw) {
  // Defensive: trim whitespace and remove trailing slashes
  if (!raw) return null;
  return String(raw).trim().replace(/\/+$/, "");
}

function buildBaseUrl(domain) {
  if (!domain) return null;
  return `${domain}/api/v2`;
}

// --- Env ---
const rawDomain = process.env.FRESHDESK_DOMAIN;
const freshdeskDomain = sanitizeDomain(rawDomain);
const baseURL = buildBaseUrl(freshdeskDomain);

const SALES_HELP_GROUP_ID = String(process.env.SALES_HELP_GROUP_ID || "").trim();
const FRESHDESK_API_KEY = process.env.FRESHDESK_API_KEY;

// IMPORTANT: Print SAFE debug (does NOT print API key)
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

// --- Routes ---
app.get("/health", (req, res) => res.send("ok"));

/**
 * Minimal suggest endpoint:
 * - Reads ticket
 * - Ensures group_id matches Sales Help
 * - Returns minimal JSON (plumbing check)
 */
app.get("/suggest", async (req, res) => {
  const ticketId = String(req.query.ticketId || "").trim();
  if (!ticketId) return res.status(400).send("Missing ticketId");

  // Validate env configuration
  if (!baseURL) return res.status(500).send("Server misconfigured: invalid FRESHDESK_DOMAIN");
  if (!FRESHDESK_API_KEY) return res.status(500).send("Server misconfigured: missing FRESHDESK_API_KEY");
  if (!SALES_HELP_GROUP_ID) return res.status(500).send("Server misconfigured: missing SALES_HELP_GROUP_ID");

  try {
    const { data: ticket } = await fd.get(`/tickets/${ticketId}`);

    if (String(ticket.group_id) !== SALES_HELP_GROUP_ID) {
      return res.json({ hide: true, reason: "Not Sales Help", group_id: ticket.group_id });
    }

    return res.json({
      ticketId,
      group_id: ticket.group_id,
      subject: ticket.subject,
      message: "Freshdesk connection working 🚀",
    });
  } catch (err) {
    // Make errors visible in Railway Logs
    console.error("Suggest error:", err.message);
    if (err.response) {
      console.error("Freshdesk status:", err.response.status);
      console.error("Freshdesk data:", err.response.data);
    }
    return res.status(500).send("Error");
  }
});

// --- Start ---
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server listening on ${port}`));
