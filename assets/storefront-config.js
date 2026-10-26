(function configureStorefront() {
  "use strict";

  const config = {
    apiBaseUrl: "https://licenses.stuffbyrambo.com/v1",
    productSku: "gesture-flow-v3",
    downloadUrl: "https://github.com/davidgreenspan15/GestureFlowMacApp/releases/latest/download/GestureFlow.dmg",
    supportEmail: "support@stuffbyrambo.com",
    policySetVersion: "gesture-flow-us-2026-10-26-v1",
    policies: Object.freeze({
      terms: "gesture-flow-terms-eula-2026-10-26-v1",
      refunds: "gesture-flow-refunds-2026-10-26-v1",
      privacy: "gesture-flow-privacy-2026-10-26-v1",
      compatibility: "gesture-flow-compatibility-2026-10-26-v1"
    }),
    paths: Object.freeze({
      catalog: "/catalog/gesture-flow",
      checkoutSessions: "/checkout-sessions",
      checkoutStatus: "/checkout-status",
      magicLink: "/portal/magic-link",
      session: "/portal/session",
      me: "/portal/me",
      refundRequests: "/portal/refund-requests",
      activationApprovals: "/portal/activations",
      devices: "/portal/devices"
    }),
    allowedCheckoutHosts: Object.freeze(["checkout.stripe.com"])
  };

  window.STUFF_BY_RAMBO_STOREFRONT = Object.freeze(config);
})();
