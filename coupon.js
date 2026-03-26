// ═══════════════════════════════════════════════════════════
// Coupon Verification API for Shopify
// Deploy to Vercel — handles verify + redeem actions
//
// ENV VARS TO SET IN VERCEL DASHBOARD:
//   SHOPIFY_STORE=new-store-upsell.myshopify.com
//   SHOPIFY_ADMIN_TOKEN=shpat_xxxxxxxxxxxxxxxx
//   STAFF_SECRET=pick-any-random-string-here
// ═══════════════════════════════════════════════════════════

const SHOPIFY_STORE = process.env.SHOPIFY_STORE;
const SHOPIFY_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;
const STAFF_SECRET  = process.env.STAFF_SECRET;
const API_VERSION   = '2024-10';

module.exports = async function handler(req, res) {

  // Handle CORS preflight
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  // Auth check
  const auth = req.headers['authorization'];
  if (!STAFF_SECRET || auth !== `Bearer ${STAFF_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { action, code } = req.body || {};
  if (!code) return res.status(400).json({ error: 'Missing code' });

  const cleanCode = code.trim();

  try {
    if (action === 'verify') return await verify(cleanCode, res);
    if (action === 'redeem') return await redeem(cleanCode, res);
    return res.status(400).json({ error: 'action must be verify or redeem' });
  } catch (err) {
    console.error('API Error:', err);
    return res.status(500).json({ error: 'Server error', detail: err.message });
  }
};


// ─── VERIFY ─────────────────────────────────────────────
async function verify(code, res) {

  // 1. Look up the discount code
  const lookup = await shopifyFetch(
    `/discount_codes/lookup.json?code=${encodeURIComponent(code)}`
  );

  if (!lookup.ok) {
    return res.json({ status: 'invalid', message: 'Code not found' });
  }

  const { discount_code } = await lookup.json();

  // 2. Get the parent price rule
  const prRes = await shopifyFetch(
    `/price_rules/${discount_code.price_rule_id}.json`
  );

  if (!prRes.ok) {
    return res.json({ status: 'invalid', message: 'Discount rule not found' });
  }

  const { price_rule } = await prRes.json();

  // 3. Check usage
  const limit = price_rule.usage_limit || Infinity;
  if (discount_code.usage_count >= limit) {
    return res.json({
      status: 'used',
      usedDate: formatDate(discount_code.updated_at)
    });
  }

  // 4. Check expiry
  if (price_rule.ends_at && new Date(price_rule.ends_at) < new Date()) {
    return res.json({
      status: 'expired',
      expiredDate: formatDate(price_rule.ends_at)
    });
  }

  // 5. Check if not yet active
  if (price_rule.starts_at && new Date(price_rule.starts_at) > new Date()) {
    return res.json({
      status: 'invalid',
      message: 'Not active until ' + formatDate(price_rule.starts_at)
    });
  }

  // 6. Valid!
  let discount = '';
  const val = Math.abs(parseFloat(price_rule.value));
  if (price_rule.value_type === 'percentage') {
    discount = val + '% off';
  } else {
    discount = '₹' + val + ' off';
  }
  discount += price_rule.target_selection === 'all' ? ' entire order' : ' selected items';

  return res.json({
    status: 'valid',
    discount,
    expires: price_rule.ends_at ? formatDate(price_rule.ends_at) : 'No expiry',
    priceRuleId: discount_code.price_rule_id,
    discountCodeId: discount_code.id
  });
}


// ─── REDEEM ─────────────────────────────────────────────
async function redeem(code, res) {

  // 1. Look up
  const lookup = await shopifyFetch(
    `/discount_codes/lookup.json?code=${encodeURIComponent(code)}`
  );

  if (!lookup.ok) {
    return res.json({ success: false, error: 'Code not found' });
  }

  const { discount_code } = await lookup.json();

  if (discount_code.usage_count > 0) {
    return res.json({ success: false, error: 'Already redeemed' });
  }

  // 2. Expire the price rule so code can't be used anywhere
  const now = new Date().toISOString();
  const prRes = await shopifyFetch(
    `/price_rules/${discount_code.price_rule_id}.json`
  );
  const { price_rule } = await prRes.json();

  const updateRes = await shopifyFetch(
    `/price_rules/${discount_code.price_rule_id}.json`,
    {
      method: 'PUT',
      body: JSON.stringify({
        price_rule: {
          id: discount_code.price_rule_id,
          ends_at: now,
          title: price_rule.title + ' [REDEEMED-INSTORE]'
        }
      })
    }
  );

  if (!updateRes.ok) {
    const errText = await updateRes.text();
    console.error('Update failed:', errText);
    return res.json({ success: false, error: 'Failed to update in Shopify' });
  }

  return res.json({ success: true, redeemedAt: now });
}


// ─── HELPERS ────────────────────────────────────────────
function shopifyFetch(path, options = {}) {
  const url = `https://${SHOPIFY_STORE}/admin/api/${API_VERSION}${path}`;
  return fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': SHOPIFY_TOKEN,
      ...(options.headers || {})
    },
    redirect: 'follow'
  });
}

function formatDate(iso) {
  if (!iso) return 'Unknown';
  return new Date(iso).toLocaleDateString('en-IN', {
    year: 'numeric', month: 'short', day: 'numeric'
  });
}
