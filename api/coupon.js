export default async function handler(req, res) {

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

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

  // ─── REDEEMED CODES TRACKING ───
  // We use Shopify metafields on the shop to track in-store redemptions
  // since we can't modify usage_count directly via API.
  // Alternative: we delete the discount code and track it separately.

  async function getRedeemedCodes() {
    try {
      const r = await shopifyFetch('/metafields.json?namespace=coupon_verify&key=redeemed_codes');
      if (!r.ok) return [];
      const data = await r.json();
      if (data.metafields && data.metafields.length > 0) {
        return JSON.parse(data.metafields[0].value);
      }
      return [];
    } catch (e) {
      return [];
    }
  }

  async function addRedeemedCode(code, metafieldId) {
    const redeemed = await getRedeemedCodes();
    const entry = {
      code: code,
      redeemedAt: new Date().toISOString(),
      method: 'in-store'
    };
    redeemed.push(entry);

    if (metafieldId) {
      // Update existing metafield
      await shopifyFetch(`/metafields/${metafieldId}.json`, {
        method: 'PUT',
        body: JSON.stringify({
          metafield: {
            id: metafieldId,
            value: JSON.stringify(redeemed)
          }
        })
      });
    } else {
      // Create new metafield
      await shopifyFetch('/metafields.json', {
        method: 'POST',
        body: JSON.stringify({
          metafield: {
            namespace: 'coupon_verify',
            key: 'redeemed_codes',
            value: JSON.stringify(redeemed),
            type: 'json'
          }
        })
      });
    }

    return entry;
  }

  async function isCodeRedeemed(code) {
    const redeemed = await getRedeemedCodes();
    return redeemed.find(r => r.code.toUpperCase() === code.toUpperCase());
  }

  async function getMetafieldId() {
    try {
      const r = await shopifyFetch('/metafields.json?namespace=coupon_verify&key=redeemed_codes');
      if (!r.ok) return null;
      const data = await r.json();
      if (data.metafields && data.metafields.length > 0) {
        return data.metafields[0].id;
      }
      return null;
    } catch (e) {
      return null;
    }
  }

  try {

    // ─── VERIFY ───
    if (action === 'verify') {

      // First check if already redeemed in-store
      const redeemed = await isCodeRedeemed(cleanCode);
      if (redeemed) {
        return res.status(200).json({
          status: 'used',
          usedDate: formatDate(redeemed.redeemedAt),
          method: 'Redeemed in-store'
        });
      }

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

      // Check if used online (usage_count from Shopify)
      const limit = price_rule.usage_limit || Infinity;
      if (discount_code.usage_count >= limit) {
        return res.status(200).json({
          status: 'used',
          usedDate: formatDate(discount_code.updated_at),
          method: 'Used online'
        });
      }

      // Check expiry
      if (price_rule.ends_at && new Date(price_rule.ends_at) < new Date()) {
        return res.status(200).json({
          status: 'expired',
          expiredDate: formatDate(price_rule.ends_at)
        });
      }

      // Check not yet active
      if (price_rule.starts_at && new Date(price_rule.starts_at) > new Date()) {
        return res.status(200).json({
          status: 'invalid',
          message: 'Not active until ' + formatDate(price_rule.starts_at)
        });
      }

      // Valid!
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

      // Check if already redeemed
      const alreadyRedeemed = await isCodeRedeemed(cleanCode);
      if (alreadyRedeemed) {
        return res.status(200).json({ success: false, error: 'Already redeemed in-store' });
      }

      // Verify code exists in Shopify
      const lookup = await shopifyFetch(
        `/discount_codes/lookup.json?code=${encodeURIComponent(cleanCode)}`
      );
      if (!lookup.ok) {
        return res.status(200).json({ success: false, error: 'Code not found' });
      }
      const { discount_code } = await lookup.json();

      // Check if used online
      if (discount_code.usage_count > 0) {
        return res.status(200).json({ success: false, error: 'Already used online' });
      }

      // Delete the discount code from Shopify so it can't be used online anymore
      const deleteRes = await shopifyFetch(
        `/price_rules/${discount_code.price_rule_id}/discount_codes/${discount_code.id}.json`,
        { method: 'DELETE' }
      );

      // Track the redemption in metafields
      const metafieldId = await getMetafieldId();
      const entry = await addRedeemedCode(cleanCode, metafieldId);

      return res.status(200).json({
        success: true,
        redeemedAt: entry.redeemedAt,
        message: 'Code deleted from Shopify and marked as redeemed in-store'
      });
    }

    // ─── LIST REDEEMED ───
    if (action === 'list-redeemed') {
      const redeemed = await getRedeemedCodes();
      return res.status(200).json({ redeemed });
    }

    return res.status(200).json({ error: 'action must be verify, redeem, or list-redeemed' });

  } catch (err) {
    console.error('API Error:', err);
    return res.status(200).json({ error: 'Server error', detail: err.message });
  }
}
