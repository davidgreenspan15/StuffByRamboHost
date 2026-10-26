-- Safe catalog bootstrap. These hashes are over the exact committed HTML bytes.
-- Published policy evidence is immutable: if a document changes, create a new
-- version/hash/policy set rather than updating these rows.

insert into public.commerce_policy_documents (
  id, document_type, version, canonical_url, sha256, published_at, effective_at
) values
  (
    '10000000-0000-4000-8000-000000000001', 'terms_of_sale',
    'gesture-flow-terms-eula-2026-07-13-v1',
    'https://stuffbyrambo.com/legal/terms.html',
    '607acb94c73fd4846f5500d052bf7dad4a703901ca28a05ef2cd22cebc88e14b',
    '2026-07-13T00:00:00Z', '2026-07-13T00:00:00Z'
  ),
  (
    '10000000-0000-4000-8000-000000000002', 'eula',
    'gesture-flow-terms-eula-2026-07-13-v1',
    'https://stuffbyrambo.com/legal/terms.html',
    '607acb94c73fd4846f5500d052bf7dad4a703901ca28a05ef2cd22cebc88e14b',
    '2026-07-13T00:00:00Z', '2026-07-13T00:00:00Z'
  ),
  (
    '10000000-0000-4000-8000-000000000003', 'privacy',
    'gesture-flow-privacy-2026-07-13-v1',
    'https://stuffbyrambo.com/legal/privacy.html',
    'd0d213bf8099ac2900dcaec5035926fcd9f08e9edd53becce09e17f0c1ce0359',
    '2026-07-13T00:00:00Z', '2026-07-13T00:00:00Z'
  ),
  (
    '10000000-0000-4000-8000-000000000004', 'refund',
    'gesture-flow-refunds-2026-07-13-v1',
    'https://stuffbyrambo.com/legal/refunds.html',
    '7b821ead6bf53bd35c535bb2500f1349c0252d717fd36480542044903e0dbe2d',
    '2026-07-13T00:00:00Z', '2026-07-13T00:00:00Z'
  ),
  (
    '10000000-0000-4000-8000-000000000005', 'compatibility',
    'gesture-flow-compatibility-2026-07-13-v1',
    'https://stuffbyrambo.com/gesture-flow/compatibility.html',
    'dba1d4843c9a48e4f6c3745512bf3e90f8bf507f40e0df0a4e16ceeecf8c25e8',
    '2026-07-13T00:00:00Z', '2026-07-13T00:00:00Z'
  )
on conflict (document_type, version) do nothing;

insert into public.commerce_policy_sets (
  id, version, terms_document_id, eula_document_id, privacy_document_id,
  refund_document_id, compatibility_document_id, published_at
) values (
  '20000000-0000-4000-8000-000000000001',
  'gesture-flow-us-2026-07-13-v1',
  '10000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000002',
  '10000000-0000-4000-8000-000000000003',
  '10000000-0000-4000-8000-000000000004',
  '10000000-0000-4000-8000-000000000005',
  '2026-07-13T00:00:00Z'
)
on conflict (version) do nothing;

-- Both offers are deliberately unpublished and non-purchasable. Activation
-- can use their current policy set for the account trial, but catalog/checkout
-- remain disabled until real Stripe product/price IDs and the final amount are
-- set explicitly in the target environment. A paid purchase activates one
-- Mac (device_limit); the account trial keeps trial_device_limit (default 2).
insert into public.commerce_offers (
  id, code, environment, product_slug, edition, display_name, description,
  billing_model, entitlement_type, licensed_major, device_limit, currency,
  unit_amount, stripe_product_id, stripe_price_id, current_policy_set_id,
  features, compatibility, published_at, checkout_enabled
) values
  (
    '30000000-0000-4000-8000-000000000001', 'gesture-flow-v3', 'test',
    'gesture-flow', 'python-mediapipe', 'Gesture Flow v3',
    'Perpetual access to Gesture Flow 3.x on one Mac.',
    'one_time', 'perpetual_major', 3, 1, 'usd', 0, null, null,
    '20000000-0000-4000-8000-000000000001',
    '["gesture-control"]'::jsonb,
    '{"minimumMacOS":"15.0","architecture":["arm64"],"permissions":["camera","accessibility"],"externalDisplayBrightness":"not_guaranteed"}'::jsonb,
    null, false
  ),
  (
    '30000000-0000-4000-8000-000000000002', 'gesture-flow-v3', 'live',
    'gesture-flow', 'python-mediapipe', 'Gesture Flow v3',
    'Perpetual access to Gesture Flow 3.x on one Mac.',
    'one_time', 'perpetual_major', 3, 1, 'usd', 0, null, null,
    '20000000-0000-4000-8000-000000000001',
    '["gesture-control"]'::jsonb,
    '{"minimumMacOS":"15.0","architecture":["arm64"],"permissions":["camera","accessibility"],"externalDisplayBrightness":"not_guaranteed"}'::jsonb,
    null, false
  )
on conflict (code, environment) do nothing;
