import { activeTypedPolicyDocuments } from "./catalog.ts";

function assert(
  condition: unknown,
  message = "assertion_failed",
): asserts condition {
  if (!condition) throw new Error(message);
}

const policySet = {
  terms_document_id: "terms",
  eula_document_id: "eula",
  privacy_document_id: "privacy",
  refund_document_id: "refund",
  compatibility_document_id: "compatibility",
};

const documentSlots: Array<[string, string]> = [
  ["terms", "terms_of_sale"],
  ["eula", "eula"],
  ["privacy", "privacy"],
  ["refund", "refund"],
  ["compatibility", "compatibility"],
];
const documents = documentSlots.map(([id, document_type]) => ({
  id,
  document_type,
  version: "test-v1",
  canonical_url: `https://stuffbyrambo.com/legal/${id}`,
  sha256: "a".repeat(64),
  published_at: "2026-07-01T00:00:00.000Z",
  effective_at: "2026-07-01T00:00:00.000Z",
  retired_at: null,
}));

Deno.test("catalog accepts only correctly slotted active policy documents", () => {
  const now = new Date("2026-07-13T00:00:00.000Z");
  assert(activeTypedPolicyDocuments(policySet, documents, now)?.length === 5);
  assert(
    activeTypedPolicyDocuments(
      policySet,
      documents.map((document) =>
        document.id === "refund"
          ? { ...document, document_type: "privacy" }
          : document
      ),
      now,
    ) === null,
  );
  assert(
    activeTypedPolicyDocuments(
      policySet,
      documents.map((document) =>
        document.id === "eula"
          ? { ...document, retired_at: "2026-07-12T00:00:00.000Z" }
          : document
      ),
      now,
    ) === null,
  );
});
