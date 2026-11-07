# PTWA India — OpenWA WhatsApp Service

A Node.js microservice for sending WhatsApp messages via [@open-wa/wa-automate](https://github.com/open-wa/wa-automate-nodejs).

## 🚀 Setup

### 1. Install Dependencies
```bash
cd c:\PTWA-Projects\OpenWA-Service
npm install
```

### 2. Configure Environment
```bash
copy .env.example .env
# Edit .env with your settings
```

### 3. Start the Service
```bash
# Development (with auto-restart)
npm run dev

# Production
npm start
```

### 4. Configure in Admin Panel
1. `admin.ptwaindia.org/admin/whatsapp` → Settings tab
2. Set **Mode** to `Live`
3. Set **Microservice URL** to `http://localhost:3001` (or your server URL)
4. Set **Service Secret Key** (must match `SERVICE_SECRET_KEY` in `.env`)
5. Save

### 5. Connect WhatsApp
1. Click **"WhatsApp Connect Karein"** in Dashboard tab
2. Scan QR code with your WhatsApp phone
3. Done! ✅

---

## 📋 API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/health` | Health check |
| GET | `/status` | Session status + QR code |
| POST | `/connect` | Start WhatsApp session |
| POST | `/disconnect` | Disconnect session |
| POST | `/send` | Send text message |
| POST | `/send-document` | Send file/image |
| POST | `/bulk-send` | Send to multiple recipients |
| GET | `/queue-status` | Queue statistics |

All endpoints require `x-wa-service-key` header.

---

## 🛡️ Anti-Ban Measures

- ✅ Random 5-30 second delays between messages
- ✅ Max 150 messages per day
- ✅ Messages sent only 9 AM – 8 PM IST
- ✅ Session persistence (saves to `./wa-session/`)
- ✅ Human-like typing simulation
- ✅ Exponential backoff on failures

---

## 🖥️ Deployment (Production Server)

For production, deploy this service on the same server as your Next.js app or on a separate VPS.

```bash
# Using PM2 (recommended)
npm install -g pm2
pm2 start server.js --name ptwa-whatsapp
pm2 save
pm2 startup
```

Then update **Microservice URL** in admin settings to your server's IP/domain.

