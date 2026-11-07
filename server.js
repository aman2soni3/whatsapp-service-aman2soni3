/**
 * PTWA India — OpenWA WhatsApp Service
 * Main Express Server
 * 
 * Endpoints:
 *   GET  /health          - Service health check
 *   GET  /status          - WhatsApp session status + QR
 *   POST /send            - Send a text message
 *   POST /send-document   - Send message + document (image/pdf)
 *   POST /disconnect      - Disconnect WhatsApp session
 */

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { createWASession, getClient, getStatus, getQRCode, disconnectSession } = require("./whatsapp");
const { enqueue, startQueueWorker } = require("./queue");
const logger = require("./logger");

const app = express();
const PORT = process.env.PORT || 3001;
const SECRET_KEY = process.env.SERVICE_SECRET_KEY || "ptwa-wa-secret";

// ─────────────────────────────────────────────────────────────
// Middleware
// ─────────────────────────────────────────────────────────────
app.use(cors({ origin: "*" }));
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true }));

// Auth middleware — check shared secret
function requireAuth(req, res, next) {
  const authHeader = req.headers["x-wa-service-key"] || req.headers["authorization"];
  const key = authHeader?.replace("Bearer ", "");
  if (!key || key !== SECRET_KEY) {
    logger.warn(`Unauthorized request from ${req.ip}`);
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

// ─────────────────────────────────────────────────────────────
// Routes
// ─────────────────────────────────────────────────────────────

/** Health check */
app.get("/health", (req, res) => {
  res.json({ status: "ok", service: "ptwa-openwa", timestamp: new Date().toISOString() });
});

/** WhatsApp session status */
app.get("/status", requireAuth, (req, res) => {
  const status = getStatus();
  const qr = getQRCode();
  res.json({ ...status, qrCode: qr || null });
});

/** Start session / get QR */
app.post("/connect", requireAuth, async (req, res) => {
  try {
    if (getStatus().connected) {
      return res.json({ success: true, message: "Already connected", connected: true });
    }
    // Start session in background — QR will be available via /status
    createWASession().catch((err) => logger.error("Session start error:", err));
    res.json({ success: true, message: "Session initializing. Poll /status for QR code." });
  } catch (err) {
    logger.error("Connect error:", err);
    res.status(500).json({ error: err.message });
  }
});

/** Disconnect session */
app.post("/disconnect", requireAuth, async (req, res) => {
  try {
    await disconnectSession();
    res.json({ success: true, message: "Disconnected" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Send a text message
 * Body: { phone, message, memberId? }
 */
app.post("/send", requireAuth, async (req, res) => {
  const { phone, message, memberId } = req.body;
  if (!phone || !message) {
    return res.status(400).json({ error: "phone and message are required" });
  }

  const job = {
    type: "text",
    phone: formatPhone(phone),
    message,
    memberId: memberId || null,
  };

  try {
    const result = await enqueue(job);
    res.json({ success: true, jobId: result.id, message: "Queued for delivery" });
  } catch (err) {
    logger.error("Send error:", err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Send a document (image or PDF) with optional caption
 * Body: { phone, message, documentUrl, documentName, documentType, memberId? }
 * documentType: 'image' | 'pdf' | 'auto'
 */
app.post("/send-document", requireAuth, async (req, res) => {
  const { phone, message, documentUrl, documentName, documentType, memberId } = req.body;

  if (!phone || !documentUrl) {
    return res.status(400).json({ error: "phone and documentUrl are required" });
  }

  const job = {
    type: "document",
    phone: formatPhone(phone),
    message: message || "",
    documentUrl,
    documentName: documentName || "PTWA_Document",
    documentType: documentType || "auto",
    memberId: memberId || null,
  };

  try {
    const result = await enqueue(job);
    res.json({ success: true, jobId: result.id, message: "Document queued for delivery" });
  } catch (err) {
    logger.error("Send-document error:", err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Send bulk messages
 * Body: { messages: [{ phone, message, documentUrl?, documentName?, documentType? }] }
 */
app.post("/bulk-send", requireAuth, async (req, res) => {
  const { messages } = req.body;
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: "messages array is required" });
  }

  if (messages.length > 500) {
    return res.status(400).json({ error: "Maximum 500 messages per bulk request" });
  }

  try {
    const jobs = messages.map((m) => ({
      type: m.documentUrl ? "document" : "text",
      phone: formatPhone(m.phone),
      message: m.message || "",
      documentUrl: m.documentUrl || null,
      documentName: m.documentName || "PTWA_Document",
      documentType: m.documentType || "auto",
      memberId: m.memberId || null,
    }));

    const results = await Promise.all(jobs.map((j) => enqueue(j)));
    res.json({ success: true, queued: results.length, jobIds: results.map((r) => r.id) });
  } catch (err) {
    logger.error("Bulk send error:", err);
    res.status(500).json({ error: err.message });
  }
});

/** Queue status */
app.get("/queue-status", requireAuth, (req, res) => {
  const { getQueueStats } = require("./queue");
  res.json(getQueueStats());
});

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

function formatPhone(phone) {
  // Remove all non-digits
  let digits = String(phone).replace(/\D/g, "");
  // Add India country code if not present
  if (digits.startsWith("0")) digits = digits.slice(1);
  if (!digits.startsWith("91") && digits.length === 10) digits = "91" + digits;
  return digits + "@c.us";
}

// ─────────────────────────────────────────────────────────────
// Start
// ─────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  logger.info(`🚀 PTWA OpenWA Service running on port ${PORT}`);
  // Start queue worker
  startQueueWorker();
  // Auto-start WhatsApp session
  logger.info("Starting WhatsApp session...");
  createWASession().catch((err) => logger.error("Initial session error:", err));
});

module.exports = app;

