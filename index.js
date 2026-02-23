require("dotenv").config();
const express = require("express");
const axios = require("axios");
const cors = require("cors");

const app = express();
app.use(cors());

const auth = {
  username: process.env.FRESHDESK_API_KEY,
  password: "X",
};

const fd = axios.create({
  baseURL: `${process.env.FRESHDESK_DOMAIN}/api/v2`,
  auth,
});

app.get("/health", (req, res) => res.send("ok"));

app.get("/suggest", async (req, res) => {
  const { ticketId } = req.query;
  if (!ticketId) return res.status(400).send("Missing ticketId");

  try {
    const { data: ticket } = await fd.get(`/tickets/${ticketId}`);

    if (String(ticket.group_id) !== process.env.SALES_HELP_GROUP_ID) {
      return res.json({ hide: true });
    }

    res.json({
      ticketId,
      subject: ticket.subject,
      message: "Freshdesk connection working 🚀",
    });
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).send("Error");
  }
});

app.listen(process.env.PORT || 3000);
