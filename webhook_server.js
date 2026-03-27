/**
 * eEquals Reimbursement Webhook Server
 * Receives inbound emails from Postmark → Claude API → Google Sheets
 *
 * Setup:
 *   npm install express @anthropic-ai/sdk googleapis crypto
 *   node webhook_server.js
 *
 * Environment variables required (create a .env file):
 *   ANTHROPIC_API_KEY=your_key_here
 *   GOOGLE_SERVICE_ACCOUNT_EMAIL=your-sa@project.iam.gserviceaccount.com
 *   GOOGLE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n..."
 *   GOOGLE_SHEET_ID=your_google_sheet_id
 *   GOOGLE_DRIVE_FOLDER_ID=your_drive_folder_id
 *   POSTMARK_WEBHOOK_TOKEN=optional_secret_for_verification
 *   PORT=3000
 */

require("dotenv").config();
const express = require("express");
const crypto = require("crypto");
const { Readable } = require("stream");
const Anthropic = require("@anthropic-ai/sdk");
const { google } = require("googleapis");

const app = express();
app.use(express.json({ limit: "50mb" }));

// ─────────────────────────────────────────────
// CLIENTS
// ─────────────────────────────────────────────

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const auth = new google.auth.JWT(
  process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
  null,
  process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n"),
  [
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/drive",
  ]
);
const sheets = google.sheets({ version: "v4", auth });
const drive = google.drive({ version: "v3", auth });

const SHEET_ID = process.env.GOOGLE_SHEET_ID;
const DRIVE_FOLDER_ID = process.env.GOOGLE_DRIVE_FOLDER_ID;
const SHEET_TAB = "Reimbursements";

// ─────────────────────────────────────────────
// SYSTEM PROMPT
// ─────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a receipt parser for eEquals, a solar sales company. Your job is to extract
structured reimbursement data from receipt images, PDFs, and email text.

You ALWAYS respond with a single valid JSON array. Each element represents one receipt.
Never include markdown, code fences, preamble, or explanation — only the raw JSON array.

RECEIPT VALIDATION
Before extracting any fields, determine if the attachment is a valid receipt.
A valid receipt must come from a merchant, vendor, airline, hotel, rental agency, or government office,
show a transaction amount and date, and NOT be a personal document, screenshot of an email,
Google Doc, blank image, car insurance card, or non-commercial document.

If invalid, return:
[{"valid_receipt": false, "invalid_reason": "Brief description", "submitter_email": "<from email>", "raw_filename": "<filename>"}]

EXTRACTION FIELDS (for valid receipts)
For each valid receipt, return:
{
  "valid_receipt": true,
  "submission_id": "<UUID v4>",
  "submitter_email": "<From email header>",
  "submitter_name": "<from email or receipt>",
  "non_company_email": <true if not @eequals.com>,
  "receipt_date": "<YYYY-MM-DD or null>",
  "vendor": "<merchant name or null>",
  "category": "<one of: Travel-Flight, Travel-Train, Car Rental, Hotel-Airbnb, Fuel, Permits, Meals, Supplies, Starlink, Other>",
  "amount_actual": <number from receipt or null>,
  "currency": "<USD unless otherwise indicated>",
  "amount_requested": <number employee is requesting, may be less than actual for capped trips>,
  "is_capped": <true if amount_requested < amount_actual>,
  "notes": "<context from email: trip name, blitz, people — max 200 chars>",
  "blitz_number": "<blitz code or null>",
  "state": "<US state or null>",
  "raw_filename": "<attachment filename>",
  "confidence": <0.0 to 1.0>,
  "confidence_notes": "<notes on uncertain fields or null>"
}

CATEGORIES: Travel-Flight, Travel-Train, Car Rental, Hotel-Airbnb, Fuel, Permits, Meals, Supplies, Starlink, Other

MULTI-RECEIPT: Return one object per attachment in one array, even if some valid and some not.

SPECIAL CASES:
- Japan trip: Many employees were capped at $2,000 (flights) or $350 (trains). Set is_capped=true accordingly.
- Starlink: Monthly $195 recurring fee. Category = "Starlink".
- Permits covering multiple people: Note in the notes field.
- null for any field you cannot determine. Never fabricate amounts or dates.
- All amounts are numbers, not strings. Dates in YYYY-MM-DD only.`;

// ─────────────────────────────────────────────
// UTILITIES
// ─────────────────────────────────────────────

function generateUUID() {
  return crypto.randomUUID();
}

function generateDedupHash(vendor, receiptDate, amountActual) {
  const key = `${vendor}|${receiptDate}|${amountActual}`;
  return crypto.createHash("sha256").update(key).digest("hex").slice(0, 16);
}

function normalizeContentType(contentType) {
  const ct = (contentType || "").toLowerCase();
  if (ct.includes("pdf")) return "application/pdf";
  if (ct.includes("png")) return "image/png";
  if (ct.includes("gif")) return "image/gif";
  if (ct.includes("webp")) return "image/webp";
  return "image/jpeg"; // default
}

function isPDF(contentType) {
  return normalizeContentType(contentType) === "application/pdf";
}

function buildUserMessage(email, attachments) {
  return `Email metadata:
- From: ${email.from}
- Subject: ${email.subject}
- Received: ${email.receivedAt}

Email body:
${email.bodyText || "(no text body)"}

---

Attachments to parse: ${attachments.length} file(s)
${attachments.map((a, i) => `Attachment ${i + 1}: ${a.filename} (${a.contentType})`).join("\n")}

Please extract reimbursement data from all attachments above.
Return one JSON object per attachment in a single array.`;
}

// ─────────────────────────────────────────────
// GOOGLE SHEETS: Check for duplicates
// ─────────────────────────────────────────────

async function checkDuplicate(dedupHash) {
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_TAB}!Y:Y`, // Column Y = dedup_hash
    });
    const hashes = (res.data.values || []).flat();
    return hashes.includes(dedupHash);
  } catch (err) {
    console.error("Duplicate check failed:", err.message);
    return false; // fail open — let it through, reviewer will catch it
  }
}

// ─────────────────────────────────────────────
// GOOGLE DRIVE: Save receipt file
// ─────────────────────────────────────────────

async function saveReceiptToDrive(base64Data, filename, contentType) {
  try {
    const buffer = Buffer.from(base64Data, "base64");
    const res = await drive.files.create({
      requestBody: {
        name: `${Date.now()}_${filename}`,
        parents: [DRIVE_FOLDER_ID],
      },
      media: {
        mimeType: contentType,
        body: Readable.from(buffer),
      },
    });
    const fileId = res.data.id;
    // Make it viewable by anyone with the link (matching existing Drive links)
    await drive.permissions.create({
      fileId,
      requestBody: { role: "reader", type: "anyone" },
    });
    return `https://drive.google.com/open?id=${fileId}`;
  } catch (err) {
    console.error("Drive upload failed:", err.message);
    return null;
  }
}

// ─────────────────────────────────────────────
// GOOGLE SHEETS: Append row
// ─────────────────────────────────────────────

async function appendToSheet(receipt, driveUrl, dedupHash, isDuplicate, webhookTimestamp) {
  // Determine status
  let status = "Pending";
  if (isDuplicate) status = "Duplicate - Review";
  else if (!receipt.valid_receipt) status = "Invalid Receipt";
  else if ((receipt.confidence || 1) < 0.75) status = "Needs Review";
  else if (receipt.non_company_email) status = "Pending - Personal Email";

  const row = [
    receipt.submission_id || generateUUID(), // A: submission_id
    webhookTimestamp,                         // B: timestamp
    receipt.submitter_name || "",             // C: submitter_name
    receipt.submitter_email || "",            // D: submitter_email
    receipt.non_company_email ? "YES" : "",   // E: non_company_email flag
    receipt.vendor || "",                     // F: vendor
    receipt.receipt_date || "",               // G: receipt_date
    receipt.category || "",                   // H: category
    receipt.amount_actual ?? "",              // I: amount_actual
    receipt.amount_requested ?? "",           // J: amount_requested
    receipt.currency || "USD",                // K: currency
    receipt.is_capped ? "YES" : "",           // L: is_capped
    receipt.notes || "",                      // M: notes
    receipt.blitz_number || "",               // N: blitz_number
    receipt.state || "",                      // O: state
    driveUrl || "",                           // P: receipt_drive_url
    receipt.valid_receipt ? "YES" : "NO",     // Q: valid_receipt
    receipt.confidence ?? "",                 // R: confidence
    receipt.confidence_notes || "",           // S: confidence_notes
    isDuplicate ? "YES" : "",                 // T: duplicate_flag
    status,                                   // U: status
    "",                                       // V: approved_by (manual)
    "",                                       // W: date_paid (manual)
    receipt.invalid_reason || "",             // X: reviewer_notes
    dedupHash,                                // Y: dedup_hash (hidden column for dedup)
  ];

  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_TAB}!A:Y`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [row] },
  });
}

// ─────────────────────────────────────────────
// CLAUDE: Parse receipts
// ─────────────────────────────────────────────

async function parseReceiptsWithClaude(email, attachments) {
  const contentBlocks = [
    { type: "text", text: buildUserMessage(email, attachments) },
    ...attachments.map((att) => ({
      type: isPDF(att.contentType) ? "document" : "image",
      source: {
        type: "base64",
        media_type: normalizeContentType(att.contentType),
        data: att.base64Data,
      },
    })),
  ];

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 4000,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: contentBlocks }],
  });

  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock) throw new Error("No text block in Claude response");

  // Strip any accidental markdown fences
  const cleaned = textBlock.text
    .replace(/```json\s*/gi, "")
    .replace(/```\s*/g, "")
    .trim();

  return JSON.parse(cleaned);
}

// ─────────────────────────────────────────────
// POSTMARK INBOUND WEBHOOK HANDLER
// ─────────────────────────────────────────────

app.post("/webhook/inbound-email", async (req, res) => {
  const webhookTimestamp = new Date().toISOString();
  console.log(`[${webhookTimestamp}] Inbound email received`);

  try {
    const payload = req.body;

    // Optional: verify Postmark webhook token
    if (process.env.POSTMARK_WEBHOOK_TOKEN) {
      const token = req.headers["x-postmark-signature"] || "";
      if (token !== process.env.POSTMARK_WEBHOOK_TOKEN) {
        return res.status(401).json({ error: "Unauthorized" });
      }
    }

    // Extract email metadata
    const email = {
      from: payload.From || payload.FromFull?.Email || "",
      subject: payload.Subject || "",
      bodyText: payload.TextBody || payload.HtmlBody?.replace(/<[^>]+>/g, " ") || "",
      receivedAt: payload.Date || webhookTimestamp,
    };

    console.log(`From: ${email.from} | Subject: ${email.subject}`);

    // Extract attachments from Postmark payload
    const rawAttachments = payload.Attachments || [];
    if (rawAttachments.length === 0) {
      console.log("No attachments — checking email body for receipt info");
      // Email body only — still try to parse
    }

    const attachments = rawAttachments
      .filter((att) => {
        // Skip tiny files (likely inline images/signatures)
        const sizeKB = (att.ContentLength || 0) / 1024;
        return sizeKB > 2;
      })
      .map((att) => ({
        filename: att.Name || "attachment",
        contentType: att.ContentType || "image/jpeg",
        base64Data: att.Content,
      }));

    // Respond to Postmark immediately (must respond within 30s)
    res.status(200).json({ received: true });

    // Process asynchronously
    setImmediate(async () => {
      try {
        let receipts;

        if (attachments.length === 0) {
          // No attachments — create a minimal entry from email body
          receipts = [{
            valid_receipt: false,
            invalid_reason: "No receipt attachment — email body only",
            submitter_email: email.from,
            submitter_name: "",
            notes: email.subject,
            raw_filename: "none",
            confidence: 0,
          }];
        } else {
          // Call Claude to parse all attachments
          receipts = await parseReceiptsWithClaude(email, attachments);
          console.log(`Claude returned ${receipts.length} receipt(s)`);
        }

        // Process each parsed receipt
        for (let i = 0; i < receipts.length; i++) {
          const receipt = receipts[i];

          // Save attachment to Google Drive
          let driveUrl = null;
          if (attachments[i]) {
            driveUrl = await saveReceiptToDrive(
              attachments[i].base64Data,
              attachments[i].filename,
              attachments[i].contentType
            );
          }

          // Dedup check
          const dedupHash = receipt.valid_receipt
            ? generateDedupHash(receipt.vendor, receipt.receipt_date, receipt.amount_actual)
            : generateUUID(); // unique hash for invalid receipts
          const isDuplicate = receipt.valid_receipt
            ? await checkDuplicate(dedupHash)
            : false;

          if (isDuplicate) {
            console.log(`Duplicate detected: ${receipt.vendor} ${receipt.receipt_date} $${receipt.amount_actual}`);
          }

          // Write to Google Sheets
          await appendToSheet(receipt, driveUrl, dedupHash, isDuplicate, webhookTimestamp);
          console.log(`Written to sheet: ${receipt.vendor || "invalid"} — ${receipt.status || "pending"}`);
        }

        console.log(`[${email.from}] Processing complete — ${receipts.length} row(s) written`);
      } catch (err) {
        console.error("Processing error:", err.message, err.stack);
        // Write a fallback error row so nothing is silently lost
        await appendToSheet(
          {
            valid_receipt: false,
            submitter_email: email.from,
            notes: email.subject,
            invalid_reason: `Processing error: ${err.message}`,
            raw_filename: "error",
            confidence: 0,
          },
          null,
          generateUUID(),
          false,
          webhookTimestamp
        ).catch(() => {}); // swallow secondary errors
      }
    });
  } catch (err) {
    console.error("Webhook handler error:", err.message);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ─────────────────────────────────────────────
// HEALTH CHECK
// ─────────────────────────────────────────────

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    sheet: SHEET_ID ? "configured" : "missing",
    drive: DRIVE_FOLDER_ID ? "configured" : "missing",
    claude: process.env.ANTHROPIC_API_KEY ? "configured" : "missing",
  });
});

// ─────────────────────────────────────────────
// START
// ─────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`eEquals Reimbursement Webhook running on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
  console.log(`Postmark endpoint: http://your-server:${PORT}/webhook/inbound-email`);
});
