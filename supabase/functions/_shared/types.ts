export interface ApiErrorBody {
  code: string;
  publicMessage: string;
  requestId: string;
  retryable?: boolean;
  revocation?: string;
}

export type CatalogResponse = {
  product: {
    sku: string;
    product: "gesture-flow";
    edition: "python-mediapipe";
    name: string;
    description: string;
    status: "published";
    published: true;
    available: true;
    purchaseAvailable: true;
    billingModel: "one_time" | "subscription";
    entitlementType: "perpetual_major" | "subscription";
    licensedMajor: number;
    deviceLimit: number;
    formattedPrice: string;
    price: { currency: string; unitAmount: number; formatted: string };
    features: string[];
    compatibility: Record<string, unknown>;
  };
  policySet: {
    version: string;
    documents: Array<{
      type: "terms_of_sale" | "eula" | "privacy" | "refund" | "compatibility";
      version: string;
      url: string;
      sha256: string;
      effectiveAt: string;
    }>;
  };
} | {
  product: {
    sku: "gesture-flow-v3";
    status: "unavailable";
    published: false;
    available: false;
    purchaseAvailable: false;
    availabilityMessage: string;
  };
};

export interface CreateCheckoutRequest {
  sku: string;
  policySetVersion: string;
  acceptances: {
    terms: true;
    refunds: true;
    compatibility: true;
  };
}

export interface CreateCheckoutResponse {
  checkoutSessionId: string;
  checkoutUrl: string;
  expiresAt: string;
}

export interface CreateActivationChallengeRequest {
  bundleId: "stuffbyrambo.GestureControlPython";
  product: "gesture-flow";
  edition: "python-mediapipe";
  majorVersion: 3;
  installationId: string;
  deviceName: string;
  devicePublicKey: string;
  deviceKeyAlgorithm: "Ed25519";
  appVersion: string;
  platform: {
    name: "macOS";
    version: string;
    architecture: string;
  };
  legacyMigration?: {
    trialStartedAt?: string;
    legacyLicenseDetected: boolean;
  };
}

export interface CreateActivationChallengeResponse {
  challengeId: string;
  userCode: string;
  verificationUri: "https://stuffbyrambo.com/license/";
  verificationUriComplete: string;
  pollToken: string;
  expiresIn: 600;
  interval: 5;
}

export interface PermitResponse {
  activationId: string;
  permit: string;
  permitExpiresAt: string;
}

export interface PortalMeResponse {
  account: { email: string };
  entitlement: Record<string, unknown> | null;
  deviceAllowance: { active: number; limit: number; remaining: number };
  trialEligible: boolean;
  orders: Array<Record<string, unknown>>;
  entitlements: Array<Record<string, unknown>>;
  devices: Array<Record<string, unknown>>;
  refundRequests: Array<Record<string, unknown>>;
}
