import type { SupabaseClient } from "@supabase/supabase-js";
import type { CommerceConfig } from "../../_shared/config.ts";
import { ApiError } from "../../_shared/http.ts";

const PRODUCT_SKU = "gesture-flow-v3";

interface CatalogPolicySet {
  terms_document_id: string;
  eula_document_id: string;
  privacy_document_id: string;
  refund_document_id: string;
  compatibility_document_id: string;
}

interface CatalogPolicyDocument {
  id: string;
  document_type: string;
  version: string;
  canonical_url: string;
  sha256: string;
  published_at: string | null;
  effective_at: string | null;
  retired_at: string | null;
}

const policyDocumentSlots = [
  ["terms_document_id", "terms_of_sale"],
  ["eula_document_id", "eula"],
  ["privacy_document_id", "privacy"],
  ["refund_document_id", "refund"],
  ["compatibility_document_id", "compatibility"],
] as const;

export function activeTypedPolicyDocuments(
  policySet: CatalogPolicySet,
  documents: CatalogPolicyDocument[],
  now: Date,
): CatalogPolicyDocument[] | null {
  if (documents.length !== policyDocumentSlots.length) return null;
  const byId = new Map(documents.map((document) => [document.id, document]));
  if (byId.size !== policyDocumentSlots.length) return null;
  const nowMs = now.getTime();
  const ordered: CatalogPolicyDocument[] = [];
  for (const [slot, expectedType] of policyDocumentSlots) {
    const document = byId.get(policySet[slot]);
    const publishedAt = document?.published_at
      ? Date.parse(document.published_at)
      : Number.NaN;
    const effectiveAt = document?.effective_at
      ? Date.parse(document.effective_at)
      : Number.NaN;
    const retiredAt = document?.retired_at
      ? Date.parse(document.retired_at)
      : null;
    if (
      !document || document.document_type !== expectedType ||
      !Number.isFinite(publishedAt) || publishedAt > nowMs ||
      !Number.isFinite(effectiveAt) || effectiveAt > nowMs ||
      (retiredAt !== null &&
        (!Number.isFinite(retiredAt) || retiredAt <= nowMs))
    ) return null;
    ordered.push(document);
  }
  return ordered;
}

function unavailable(message: string): Record<string, unknown> {
  return {
    product: {
      sku: PRODUCT_SKU,
      status: "unavailable",
      published: false,
      available: false,
      purchaseAvailable: false,
      availabilityMessage: message,
    },
  };
}

export async function catalog(
  config: CommerceConfig,
  client: SupabaseClient,
): Promise<Record<string, unknown>> {
  const nowDate = new Date();
  const now = nowDate.toISOString();
  const { data: offer, error } = await client
    .from("commerce_offers")
    .select(
      "id,code,product_slug,edition,display_name,description,billing_model,entitlement_type,licensed_major,device_limit,currency,unit_amount,current_policy_set_id,features,compatibility,published_at,checkout_enabled,stripe_price_id,tax_code",
    )
    .eq("code", PRODUCT_SKU)
    .eq("environment", config.stripeEnvironment)
    .eq("checkout_enabled", true)
    .not("stripe_price_id", "is", null)
    .lte("published_at", now)
    .maybeSingle();
  if (error) {
    throw new ApiError(
      503,
      "catalog_unavailable",
      "Purchase information is temporarily unavailable.",
      true,
    );
  }
  if (!offer) {
    return unavailable(
      "Purchases are not available yet. Please check back after release verification.",
    );
  }
  if (
    config.stripeManagedPayments &&
    (typeof offer.tax_code !== "string" ||
      !config.stripeManagedPaymentsEligibleTaxCodes.includes(offer.tax_code))
  ) {
    return unavailable("Purchase tax classification is not configured yet.");
  }

  const { data: policySet, error: policyError } = await client
    .from("commerce_policy_sets")
    .select(
      "id,version,published_at,retired_at,terms_document_id,eula_document_id,privacy_document_id,refund_document_id,compatibility_document_id",
    )
    .eq("id", offer.current_policy_set_id)
    .lte("published_at", now)
    .or(`retired_at.is.null,retired_at.gt.${now}`)
    .maybeSingle();
  if (policyError || !policySet) {
    return unavailable("The current purchase terms are not published.");
  }

  const documentIds = [
    policySet.terms_document_id,
    policySet.eula_document_id,
    policySet.privacy_document_id,
    policySet.refund_document_id,
    policySet.compatibility_document_id,
  ];
  const { data: documents, error: documentError } = await client
    .from("commerce_policy_documents")
    .select(
      "id,document_type,version,canonical_url,sha256,effective_at,published_at,retired_at",
    )
    .in("id", documentIds);
  const activeDocuments = !documentError && documents
    ? activeTypedPolicyDocuments(policySet, documents, nowDate)
    : null;
  if (!activeDocuments) {
    return unavailable("The current purchase documents are not published.");
  }
  const formattedPrice = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: String(offer.currency).toUpperCase(),
  }).format(Number(offer.unit_amount) / 100);

  return {
    product: {
      sku: offer.code,
      product: offer.product_slug,
      edition: offer.edition,
      name: offer.display_name,
      description: offer.description,
      status: "published",
      published: true,
      available: true,
      purchaseAvailable: true,
      billingModel: offer.billing_model,
      entitlementType: offer.entitlement_type,
      licensedMajor: offer.licensed_major,
      deviceLimit: offer.device_limit,
      formattedPrice,
      price: {
        currency: offer.currency,
        unitAmount: offer.unit_amount,
        formatted: formattedPrice,
      },
      features: offer.features,
      compatibility: offer.compatibility,
    },
    policySet: {
      version: policySet.version,
      documents: activeDocuments.map((document) => ({
        type: document.document_type,
        version: document.version,
        url: document.canonical_url,
        sha256: document.sha256,
        effectiveAt: document.effective_at,
      })),
    },
  };
}
