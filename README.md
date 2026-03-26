# Coupon Verification API — Deployment Guide

## What This Does
A simple backend that lets your store staff verify and redeem 
Klaviyo-generated coupon codes against your Shopify store.
Staff use a verification page on your Shopify site, which calls 
this API to check codes in real-time.

## Pre-configured for: new-store-upsell.myshopify.com

---

## STEP 1: Get Your Shopify Admin API Token

1. Go to your Shopify Admin → Settings → Apps and sales channels
2. Click "Develop apps" (top right)
3. Click "Allow custom app development" if prompted
4. Click "Create an app" — name it "Coupon Verifier"
5. Click "Configure Admin API scopes"
6. Search and enable these scopes:
   - read_discounts
   - write_discounts
   - read_price_rules  
   - write_price_rules
7. Click Save, then click "Install app"
8. Click "Reveal token once" — COPY THIS TOKEN (starts with shpat_)
   ⚠️ You can only see this once! Save it somewhere safe.

---

## STEP 2: Deploy to Vercel

### Option A: Deploy via Vercel CLI (if you have it)
```bash
cd coupon-verify-api
vercel login
vercel
```

### Option B: Deploy via GitHub (easier)
1. Create a new GitHub repository
2. Upload these files to it:
   - vercel.json
   - package.json
   - api/coupon.js
3. Go to vercel.com → New Project → Import your GitHub repo
4. Click Deploy

---

## STEP 3: Set Environment Variables in Vercel

1. Go to your Vercel project → Settings → Environment Variables
2. Add these three variables:

   SHOPIFY_STORE        = new-store-upsell.myshopify.com
   SHOPIFY_ADMIN_TOKEN  = shpat_xxxxxxxxxxxxxxxxxxxx  (from Step 1)
   STAFF_SECRET         = pick-any-random-string-here  (make one up, e.g. "mystore2026secure")

3. Redeploy after adding variables (Deployments → click ⋮ → Redeploy)

---

## STEP 4: Test Your API

Your API will be live at: https://your-project-name.vercel.app/api/coupon

Test with curl or Postman:
```bash
curl -X POST https://your-project-name.vercel.app/api/coupon \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer pick-any-random-string-here" \
  -d '{"action":"verify","code":"storedicount-XXXXX"}'
```

Replace the code with an actual code from your Shopify Discounts page.

---

## STEP 5: Install Staff Verification Page on Shopify

1. Go to Shopify Admin → Online Store → Themes → Edit Code
2. Under Templates, click "Add a new template"
3. Select "page", name it "staff-verify"
4. Paste the contents of page.staff-verify.liquid
5. IMPORTANT: Update these two values in the file:
   - CONFIG.API_URL = 'https://your-project-name.vercel.app/api/coupon'
   - CONFIG.STAFF_SECRET = 'pick-any-random-string-here' (same as Vercel)
6. Save
7. Go to Pages → Add Page → Template: staff-verify → Save
8. Staff access it at: new-store-upsell.myshopify.com/pages/staff-verify

---

## How It Works
1. Customer fills out Klaviyo form → gets unique code (e.g. storedicount-X7FK29)
2. Customer visits store, shows code
3. Staff opens verification page, enters code or scans QR
4. Page calls your Vercel API → API checks Shopify → returns valid/invalid
5. Staff taps "Redeem" → API expires the code in Shopify
6. Staff applies matching discount manually in their POS
7. Code is now dead everywhere (online + in-store)
