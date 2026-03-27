# eEquals Reimbursement Webhook — Setup Guide

## 1. Install dependencies

```bash
npm init -y
npm install express @anthropic-ai/sdk googleapis dotenv
```

---

## 2. Create .env file

Copy this and fill in your values:

```
ANTHROPIC_API_KEY=sk-ant-...
GOOGLE_SERVICE_ACCOUNT_EMAIL=reimbursements@your-project.iam.gserviceaccount.com
GOOGLE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nMIIE...\n-----END PRIVATE KEY-----\n"
GOOGLE_SHEET_ID=1BxCNW9KB2iNEVxHCsEBISpvyk-TgSd80
GOOGLE_DRIVE_FOLDER_ID=1abc123def456
POSTMARK_WEBHOOK_TOKEN=optional-secret-string
PORT=3000
```

---

## 3. Google Cloud setup (10 min)

### Create a Service Account
1. Go to console.cloud.google.com → IAM & Admin → Service Accounts
2. Create service account: "eequals-reimbursements"
3. Create JSON key → download it
4. Copy `client_email` → GOOGLE_SERVICE_ACCOUNT_EMAIL
5. Copy `private_key` → GOOGLE_PRIVATE_KEY

### Share Google Sheet with the service account
1. Open your Google Sheet
2. Share → add the service account email with Editor access
3. Copy the Sheet ID from the URL:
   `https://docs.google.com/spreadsheets/d/THIS_IS_THE_ID/edit`

### Share Google Drive folder with the service account
1. Create a folder in Drive: "eEquals Receipts"
2. Share → add service account email with Editor access
3. Right-click folder → Get link → copy the folder ID from the URL

---

## 4. Google Sheet setup

Create a sheet tab called "Reimbursements" with these headers in row 1:

| A | B | C | D | E | F | G | H | I | J | K | L | M | N | O | P | Q | R | S | T | U | V | W | X | Y |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| submission_id | timestamp | submitter_name | submitter_email | non_company_email | vendor | receipt_date | category | amount_actual | amount_requested | currency | is_capped | notes | blitz_number | state | receipt_drive_url | valid_receipt | confidence | confidence_notes | duplicate_flag | status | approved_by | date_paid | reviewer_notes | dedup_hash |

Freeze row 1. Format columns I and J as currency. Format column G as date.
You can hide column Y (dedup_hash) — it's used internally.

---

## 5. Postmark setup (15 min)

1. Sign up at postmarkapp.com (free for inbound)
2. Go to Servers → Create Server → "eEquals Reimbursements"
3. Go to Settings → Inbound
4. Set your webhook URL: `https://your-server.com/webhook/inbound-email`
5. Note your Inbound Email Address: `abc123@inbound.postmarkapp.com`

### DNS: Point receipts@eequals.com to Postmark

Add this MX record in your DNS provider (wherever eequals.com DNS is managed):

```
Type: MX
Host: receipts          (creates receipts.eequals.com subdomain)
Value: inbound.postmarkapp.com
Priority: 10
TTL: 300
```

Then in Postmark → Inbound → add custom domain: `receipts.eequals.com`

After DNS propagates (~30 min), emails to `receipts@eequals.com` will flow
through Postmark and hit your webhook.

---

## 6. Deploy the webhook server

### Option A: Railway (easiest, ~$5/mo)
```bash
# Install Railway CLI
npm install -g @railway/cli
railway login
railway init
railway up
# Add environment variables in Railway dashboard
```

### Option B: Render (free tier available)
1. Push code to GitHub
2. New Web Service on render.com → connect repo
3. Add env vars in dashboard

### Option C: Your own VPS (DigitalOcean, etc.)
```bash
# Install PM2 for process management
npm install -g pm2
pm2 start webhook_server.js --name eequals-reimbursements
pm2 save
pm2 startup
```

---

## 7. Test it

Send a test email with a receipt to `receipts@eequals.com` (or the Postmark
inbound address while DNS propagates) and check:

1. Postmark dashboard → Activity → confirm email was received
2. Your server logs → confirm Claude was called
3. Google Sheet → confirm row was written

### Health check
```bash
curl https://your-server.com/health
```

Should return:
```json
{
  "status": "ok",
  "sheet": "configured",
  "drive": "configured",
  "claude": "configured"
}
```

---

## 8. Notify your team

Send this to everyone who submits reimbursements:

---

**New reimbursement process:**

Email your receipts to **receipts@eequals.com**

- Attach receipts as photos or PDFs
- Multiple receipts per email are fine
- Use the subject line for context (e.g. "Blitz 53 - fuel stops OH")
- Include your blitz number in the email body if applicable
- You'll see your submission appear in the tracking sheet within a few minutes

Questions? Contact [admin name].

---
