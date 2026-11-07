/**
 * PTWA India — Message Queue Processor
 * 
 * Anti-ban rules enforced here:
 * 1. Random delay between messages (5-30 seconds)
 * 2. Daily send limit (150 messages)
 * 3. Send window: 9 AM - 8 PM IST only
 * 4. Retry failed messages (max 3 retries)
 */

const { sendTextMessage, sendDocument, getStatus } = require("./whatsapp");
const logger = require("./logger");

// In-memory queue
const queue = [];
let isProcessing = false;
let dailySentCount = 0;
let dailyDate = new Date().toDateString();

const DAILY_LIMIT = parseInt(process.env.DAILY_MSG_LIMIT || "150");
const MIN_DELAY = parseInt(process.env.MIN_DELAY_MS || "5000");
const MAX_DELAY = parseInt(process.env.MAX_DELAY_MS || "30000");
const SEND_HOUR_START = 9;  // 9 AM IST
const SEND_HOUR_END = 20;   // 8 PM IST

let jobIdCounter = 1;

/**
 * Add a job to the queue
 */
async function enqueue(job) {
  const id = `job_${Date.now()}_${jobIdCounter++}`;
  const queueJob = { id, ...job, status: "queued", retries: 0, createdAt: new Date() };
  queue.push(queueJob);
  logger.info(`📬 Queued: ${id} → ${job.phone} (${job.type})`);
  return { id };
}

/**
 * Get queue statistics
 */
function getQueueStats() {
  return {
    total: queue.length,
    queued: queue.filter((j) => j.status === "queued").length,
    sending: queue.filter((j) => j.status === "sending").length,
    sent: queue.filter((j) => j.status === "sent").length,
    failed: queue.filter((j) => j.status === "failed").length,
    dailySentToday: dailySentCount,
    dailyLimit: DAILY_LIMIT,
  };
}

/**
 * Start the queue worker (runs every 2 seconds)
 */
function startQueueWorker() {
  logger.info("📡 Queue worker started");
  setInterval(processNext, 2000);
}

/**
 * Process the next job in queue
 */
async function processNext() {
  if (isProcessing) return;

  // Reset daily counter if new day
  const todayStr = new Date().toDateString();
  if (todayStr !== dailyDate) {
    dailySentCount = 0;
    dailyDate = todayStr;
    logger.info("🔄 Daily send counter reset");
  }

  // Check daily limit
  if (dailySentCount >= DAILY_LIMIT) {
    return; // Will try again tomorrow
  }

  // Check send window (IST = UTC+5:30)
  if (!isWithinSendWindow()) {
    return; // Outside allowed hours
  }

  // Find next queued job
  const job = queue.find((j) => j.status === "queued");
  if (!job) return;

  // Check if WA is connected
  const status = getStatus();
  if (!status.connected) {
    logger.warn("⚠️ WA not connected — queue paused");
    return;
  }

  isProcessing = true;
  job.status = "sending";

  try {
    logger.info(`📤 Sending: ${job.id} → ${job.phone}`);

    if (job.type === "text") {
      await sendTextMessage(job.phone, job.message);
    } else if (job.type === "document") {
      // First send the caption text if any
      if (job.message) {
        await sendTextMessage(job.phone, job.message);
        // Small pause between text and document
        await randomDelay(2000, 5000);
      }
      await sendDocument(job.phone, job.documentUrl, job.documentName, "");
    }

    job.status = "sent";
    job.sentAt = new Date();
    dailySentCount++;
    logger.info(`✅ Sent: ${job.id} (daily: ${dailySentCount}/${DAILY_LIMIT})`);

    // Anti-ban: random delay before next message
    const delay = randomInt(MIN_DELAY, MAX_DELAY);
    logger.info(`⏱️ Next message in ${(delay / 1000).toFixed(1)}s`);
    await randomDelay(delay, delay);

  } catch (err) {
    job.retries = (job.retries || 0) + 1;
    logger.error(`❌ Failed: ${job.id} (attempt ${job.retries}):`, err.message);

    if (job.retries >= 3) {
      job.status = "failed";
      job.error = err.message;
      logger.error(`💀 Giving up on job: ${job.id}`);
    } else {
      job.status = "queued"; // Retry
      // Exponential backoff: 30s, 60s, 120s
      await randomDelay(30000 * job.retries, 30000 * job.retries);
    }
  } finally {
    isProcessing = false;
  }
}

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

function isWithinSendWindow() {
  // IST = UTC+5:30
  const now = new Date();
  const istOffset = 5.5 * 60 * 60 * 1000;
  const istNow = new Date(now.getTime() + istOffset);
  const hour = istNow.getUTCHours();
  return hour >= SEND_HOUR_START && hour < SEND_HOUR_END;
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomDelay(minMs, maxMs) {
  const ms = randomInt(minMs, maxMs);
  return new Promise((r) => setTimeout(r, ms));
}

module.exports = { enqueue, startQueueWorker, getQueueStats };

