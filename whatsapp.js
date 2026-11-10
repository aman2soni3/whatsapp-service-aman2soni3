/**
 * PTWA India — WhatsApp Session Engine (Baileys Native Socket)
 * 
 * Why Baileys instead of Puppeteer/OpenWA:
 * 1. 100% Native WhatsApp Web Protocol (WebSocket) — No Chromium, No Chrome crashes
 * 2. Works reliably on Windows 11 & servers without wmic.exe errors
 * 3. 10x lighter on RAM (~40MB vs ~600MB Chromium)
 * 4. Meta anti-ban friendly: handles presence, keepalive, and normal WA client handshake
 */

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  delay,
  Browsers
} = require("@whiskeysockets/baileys");
const pino = require("pino");
const QRCode = require("qrcode");
const path = require("path");
const fs = require("fs");
const axios = require("axios");
const logger = require("./logger");

const SESSION_PATH = path.resolve(__dirname, process.env.SESSION_DATA_PATH || "./wa-session");
if (!fs.existsSync(SESSION_PATH)) {
  fs.mkdirSync(SESSION_PATH, { recursive: true });
}

let _sock = null;
let _status = {
  connected: false,
  ready: false,
  phone: null,
  battery: null,
  lastSeen: null,
  state: "DISCONNECTED", // DISCONNECTED | INITIALIZING | QR_READY | CONNECTED
};
let _qrCode = null; // data:image/png;base64,...

/**
 * Start or restore WhatsApp connection
 */
async function createWASession() {
  if (_sock && _status.connected) {
    logger.info("WA session already active");
    return _sock;
  }

  _status.state = "INITIALIZING";
  logger.info("Starting WhatsApp Socket Session (Baileys)...");

  try {
    const { state, saveCreds } = await useMultiFileAuthState(SESSION_PATH);
    const { version } = await fetchLatestBaileysVersion();
    logger.info(`Using WA Web Version: ${version.join(".")}`);

    _sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: true,
      logger: pino({ level: "silent" }),
      browser: Browsers ? Browsers.ubuntu("Chrome") : ["Ubuntu", "Chrome", "20.0.04"],
      syncFullHistory: false,
      generateHighQualityLinkPreview: true,
      connectTimeoutMs: 60000,
    });

    _sock.ev.on("creds.update", saveCreds);

    _sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        logger.info("New QR Code generated");
        _status.state = "QR_READY";
        _status.lastError = null;
        try {
          _qrCode = await QRCode.toDataURL(qr);
        } catch (qrErr) {
          logger.error("QR Code generation error:", qrErr);
        }
      }

      if (connection === "close") {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const errMsg = lastDisconnect?.error?.message || `Closed with code ${statusCode}`;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        logger.warn(`WhatsApp connection closed. Status: ${statusCode}. Error: ${errMsg}. Reconnecting: ${shouldReconnect}`);

        _status.connected = false;
        _status.ready = false;
        _status.state = "DISCONNECTED";
        _status.lastError = errMsg;
        _status.statusCode = statusCode;
        _status.phone = null;
        _qrCode = null;

        if (shouldReconnect) {
          setTimeout(() => {
            createWASession().catch((err) => logger.error("Reconnection error:", err));
          }, 5000);
        } else {
          logger.warn("Session logged out. Clear wa-session directory to scan new QR.");
        }
      } else if (connection === "open") {
        logger.info("✅ WhatsApp connected successfully!");
        _status.connected = true;
        _status.ready = true;
        _status.state = "CONNECTED";
        _qrCode = null;

        const userJid = _sock?.user?.id || "";
        _status.phone = userJid.split(":")[0] || userJid.split("@")[0] || null;
        _status.lastSeen = new Date().toISOString();
        logger.info(`Connected Account Phone: ${_status.phone}`);
      }
    });

    return _sock;
  } catch (err) {
    logger.error("Error creating WhatsApp socket session:", err);
    _status.state = "DISCONNECTED";
    _status.connected = false;
    throw err;
  }
}

/**
 * Format recipient JID
 * e.g., 919876543210 -> 919876543210@s.whatsapp.net
 */
function toJid(phone) {
  let clean = String(phone).replace(/\D/g, "");
  if (clean.startsWith("0")) clean = clean.slice(1);
  if (!clean.startsWith("91") && clean.length === 10) clean = "91" + clean;
  return clean + "@s.whatsapp.net";
}

/**
 * Send Text Message
 */
async function sendTextMessage(phone, message) {
  if (!_sock || !_status.connected) {
    throw new Error("WhatsApp not connected");
  }

  const jid = toJid(phone);

  // Simulate human typing presence
  try {
    await _sock.presenceSubscribe(jid);
    await delay(500);
    await _sock.sendPresenceUpdate("composing", jid);
    await delay(Math.min(Math.max(message.length * 40, 1000), 3000));
    await _sock.sendPresenceUpdate("paused", jid);
  } catch (_) {}

  const result = await _sock.sendMessage(jid, { text: message });
  logger.info(`✉️ Text sent to ${jid} — msgId: ${result?.key?.id}`);
  return result?.key?.id;
}

/**
 * Send Document or Image
 */
async function sendDocument(phone, fileUrl, fileName, caption = "") {
  if (!_sock || !_status.connected) {
    throw new Error("WhatsApp not connected");
  }

  const jid = toJid(phone);
  logger.info(`Downloading file for WhatsApp dispatch: ${fileUrl}`);

  const serviceSecret = process.env.SERVICE_SECRET_KEY || "ptwa-wa-secret";
  const response = await axios.get(fileUrl, {
    responseType: "arraybuffer",
    timeout: 45000,
    headers: {
      "x-wa-service-key": serviceSecret,
    },
  });

  const buffer = Buffer.from(response.data);
  const headStr = buffer.slice(0, 100).toString("utf8").trim();
  if (headStr.startsWith("{") || headStr.startsWith("<!DOCTYPE") || headStr.startsWith("<html")) {
    throw new Error(`File download returned non-binary content (JSON/HTML) from ${fileUrl}`);
  }

  const ext = (fileName || "").split(".").pop()?.toLowerCase();
  const isImage = ["jpg", "jpeg", "png", "webp"].includes(ext);

  // Presence typing
  try {
    await _sock.sendPresenceUpdate("composing", jid);
    await delay(1200);
    await _sock.sendPresenceUpdate("paused", jid);
  } catch (_) {}

  let result;
  if (isImage) {
    result = await _sock.sendMessage(jid, {
      image: buffer,
      caption: caption || undefined,
      fileName: fileName || "image.png"
    });
  } else {
    // Send as PDF / general document
    result = await _sock.sendMessage(jid, {
      document: buffer,
      mimetype: ext === "pdf" ? "application/pdf" : "application/octet-stream",
      fileName: fileName || "Document.pdf",
      caption: caption || undefined
    });
  }

  logger.info(`📎 Document sent to ${jid} — file: ${fileName} — msgId: ${result?.key?.id}`);
  return result?.key?.id;
}

/**
 * Disconnect WhatsApp Session
 */
async function disconnectSession() {
  if (_sock) {
    try {
      await _sock.logout();
    } catch (_) {}
    _sock = null;
  }
  _status = {
    connected: false,
    ready: false,
    phone: null,
    battery: null,
    lastSeen: null,
    state: "DISCONNECTED",
  };
  _qrCode = null;
  logger.info("WhatsApp session disconnected");
}

function resetSession() {
  try {
    if (_sock) {
      try { _sock.end(undefined); } catch (_) {}
      _sock = null;
    }
    if (fs.existsSync(SESSION_PATH)) {
      const files = fs.readdirSync(SESSION_PATH);
      for (const file of files) {
        try { fs.unlinkSync(path.join(SESSION_PATH, file)); } catch (_) {}
      }
    }
  } catch (err) {
    logger.error("Reset session files error:", err);
  }
  _status = {
    connected: false,
    ready: false,
    phone: null,
    battery: null,
    lastSeen: null,
    state: "DISCONNECTED",
    lastError: "Session reset requested",
  };
  _qrCode = null;
  logger.info("WhatsApp session reset completely");
}

function getClient() { return _sock; }
function getStatus() { return { ..._status }; }
function getQRCode() { return _qrCode; }

module.exports = {
  createWASession,
  getClient,
  getStatus,
  getQRCode,
  sendTextMessage,
  sendDocument,
  disconnectSession,
  resetSession,
};
