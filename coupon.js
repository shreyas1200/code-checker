export default async function handler(req, res) {

  // CORS headers — must be on EVERY response
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  // Handle preflight immediately
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(200).json({ error: 'POST only' });
  }

  const SHOPIFY_STORE = process.env.SHOPIFY_STORE;
  const SHOPIFY_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;
  const STAFF_SECRET  = process.env.STAFF_SECRET;
  const API_VERSION   = '2024-10';

  // Auth check
  const auth = req.headers['authorization'];
  if (!STAFF_SECRET || auth !== `Bearer ${STAFF_SECRET}`) {
    return res.status(200).json({ error: 'Unauthorized' });
  }

  const { action, code } = req.body || {};
  if (!code) return res.status(200).json({ error: 'Missing code' });

  const cleanCode = code.trim();

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

  try {

    // ─── VERIFY ───
    if (action === 'verify') {
      const lookup = await shopifyFetch(
        `/discount_codes/lookup.json?code=${encodeURIComponent(cleanCode)}`
      );
      if (!lookup.ok) {
        return res.status(200).json({ status: 'invalid', message: 'Code not found' });
      }
      const { discount_code } = await lookup.json();

      const prRes = await shopifyFetch(
        `/price_rules/${discount_code.price_rule_id}.json`
      );
      if (!prRes.ok) {
        return res.status(200).json({ status: 'invalid', message: 'Discount rule not found' });
      }
      const { price_rule } = await prRes.json();

      const limit = price_rule.usage_limit || Infinity;
      if (discount_code.usage_count >= limit) {
        return res.status(200).json({
          status: 'used',
          usedDate: formatDate(discount_code.updated_at)
        });
      }

      if (price_rule.ends_at && new Date(price_rule.ends_at) < new Date()) {
        return res.status(200).json({
          status: 'expired',
          expiredDate: formatDate(price_rule.ends_at)
        });
      }

      if (price_rule.starts_at && new Date(price_rule.starts_at) > new Date()) {
        return res.status(200).json({
          status: 'invalid',
          message: 'Not active until ' + formatDate(price_rule.starts_at)
        });
      }

      let discount = '';
      const val = Math.abs(parseFloat(price_rule.value));
      if (price_rule.value_type === 'percentage') {
        discount = val + '% off';
      } else {
        discount = '₹' + val + ' off';
      }
      discount += price_rule.target_selection === 'all' ? ' entire order' : ' selected items';

      return res.status(200).json({
        status: 'valid',
        discount,
        expires: price_rule.ends_at ? formatDate(price_rule.ends_at) : 'No expiry',
        priceRuleId: discount_code.price_rule_id,
        discountCodeId: discount_code.id
      });
    }

    // ─── REDEEM ───
    if (action === 'redeem') {
      const lookup = await shopifyFetch(
        `/discount_codes/lookup.json?code=${encodeURIComponent(cleanCode)}`
      );
      if (!lookup.ok) {
        return res.status(200).json({ success: false, error: 'Code not found' });
      }
      const { discount_code } = await lookup.json();

      if (discount_code.usage_count > 0) {
        return res.status(200).json({ success: false, error: 'Already redeemed' });
      }

      const prRes = await shopifyFetch(
        `/price_rules/${discount_code.price_rule_id}.json`
      );
      const { price_rule } = await prRes.json();

      const now = new Date().toISOString();
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
        return res.status(200).json({ success: false, error: 'Failed to update in Shopify' });
      }

      return res.status(200).json({ success: true, redeemedAt: now });
    }

    return res.status(200).json({ error: 'action must be verify or redeem' });

  } catch (err) {
    console.error('API Error:', err);
    return res.status(200).json({ error: 'Server error', detail: err.message });
  }
}
