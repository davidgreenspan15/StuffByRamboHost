(function initializeStorefront() {
  "use strict";

  const config = window.STUFF_BY_RAMBO_STOREFRONT;
  if (!config) {
    return;
  }

  let csrfToken = "";

  class ApiError extends Error {
    constructor(message, status) {
      super(message);
      this.name = "ApiError";
      this.status = status;
    }
  }

  function byId(id) {
    return document.getElementById(id);
  }

  function setHidden(element, hidden) {
    if (element) {
      element.hidden = hidden;
    }
  }

  function setStatus(element, message, tone) {
    if (!element) {
      return;
    }

    element.textContent = message;
    element.dataset.tone = tone || "neutral";
    element.hidden = !message;
  }

  function setBusy(button, busy, busyLabel) {
    if (!button) {
      return;
    }

    if (busy) {
      button.dataset.readyLabel = button.textContent;
      button.textContent = busyLabel;
      button.disabled = true;
    } else {
      button.textContent = button.dataset.readyLabel || button.textContent;
      button.disabled = false;
    }
  }

  function createIdempotencyKey(scope) {
    if (window.crypto && typeof window.crypto.randomUUID === "function") {
      return `${scope}-${window.crypto.randomUUID()}`;
    }

    const bytes = new Uint8Array(16);
    window.crypto.getRandomValues(bytes);
    const value = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
    return `${scope}-${value}`;
  }

  function apiUrl(path) {
    const base = config.apiBaseUrl.replace(/\/$/, "");
    const suffix = path.startsWith("/") ? path : `/${path}`;
    return `${base}${suffix}`;
  }

  function safePublicMessage(payload, fallback) {
    const message = payload && typeof payload.publicMessage === "string" ? payload.publicMessage.trim() : "";
    return message && message.length <= 240 ? message : fallback;
  }

  async function apiRequest(path, options) {
    const request = options || {};
    const method = (request.method || "GET").toUpperCase();
    const headers = new Headers(request.headers || {});
    headers.set("Accept", "application/json");

    if (request.body !== undefined) {
      headers.set("Content-Type", "application/json");
    }

    if (csrfToken && !["GET", "HEAD", "OPTIONS"].includes(method)) {
      headers.set("X-CSRF-Token", csrfToken);
    }

    let response;
    try {
      response = await fetch(apiUrl(path), {
        method,
        headers,
        body: request.body === undefined ? undefined : JSON.stringify(request.body),
        credentials: "include",
        cache: "no-store",
        referrerPolicy: "no-referrer"
      });
    } catch {
      throw new ApiError("We could not reach the license service. Please try again shortly.", 0);
    }

    const responseCsrfToken = response.headers.get("X-CSRF-Token");
    if (responseCsrfToken) {
      csrfToken = responseCsrfToken;
    }

    let payload = null;
    if (response.status !== 204) {
      const contentType = response.headers.get("Content-Type") || "";
      if (contentType.includes("application/json")) {
        try {
          payload = await response.json();
        } catch {
          payload = null;
        }
      }
    }

    if (!response.ok) {
      const fallback = response.status === 401
        ? "Your secure session has expired. Request a new sign-in link."
        : "The request could not be completed. Please try again.";
      throw new ApiError(safePublicMessage(payload, fallback), response.status);
    }

    if (payload && typeof payload.csrfToken === "string") {
      csrfToken = payload.csrfToken;
    }

    return payload || {};
  }

  function formatDate(value) {
    if (!value) {
      return "Not available";
    }

    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return "Not available";
    }

    return new Intl.DateTimeFormat(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric"
    }).format(date);
  }

  function formatMoney(minorUnits, currency) {
    const amount = Number(minorUnits);
    const normalizedCurrency = typeof currency === "string" ? currency.toUpperCase() : "";
    if (!Number.isInteger(amount) || amount < 0 || !/^[A-Z]{3}$/.test(normalizedCurrency)) {
      return "Amount unavailable";
    }

    try {
      return new Intl.NumberFormat(undefined, {
        style: "currency",
        currency: normalizedCurrency
      }).format(amount / 100);
    } catch {
      return `${(amount / 100).toFixed(2)} ${normalizedCurrency}`;
    }
  }

  function validDisplayPrice(value) {
    return typeof value === "string" && value.trim().length > 0 && value.trim().length <= 40;
  }

  function catalogPoliciesMatch(payload) {
    const policySet = payload && payload.policySet;
    const documents = policySet && Array.isArray(policySet.documents) ? policySet.documents : [];
    const expectedVersions = new Map([
      ["terms_of_sale", config.policies.terms],
      ["eula", config.policies.terms],
      ["privacy", config.policies.privacy],
      ["refund", config.policies.refunds],
      ["compatibility", config.policies.compatibility]
    ]);

    if (policySet?.version !== config.policySetVersion || documents.length !== expectedVersions.size) {
      return false;
    }

    const seenTypes = new Set();
    for (const document of documents) {
      const type = document && typeof document.type === "string" ? document.type : "";
      const expectedVersion = expectedVersions.get(type);
      if (
        !expectedVersion || seenTypes.has(type) || document.version !== expectedVersion ||
        typeof document.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(document.sha256)
      ) {
        return false;
      }
      seenTypes.add(type);
    }

    return seenTypes.size === expectedVersions.size;
  }

  function normalizeCatalog(payload) {
    const product = payload && payload.product ? payload.product : payload;
    const formattedPrice = product && (
      product.formattedPrice ||
      product.priceDisplay ||
      (product.price && product.price.formatted)
    );
    const published = Boolean(product) && (product.published === true || product.status === "published");
    const skuMatches = !product || !product.sku || product.sku === config.productSku;
    const explicitlyUnavailable = product && (product.available === false || product.purchaseAvailable === false);
    const policiesMatch = catalogPoliciesMatch(payload);

    return {
      formattedPrice: validDisplayPrice(formattedPrice) ? formattedPrice.trim() : "",
      available: Boolean(product) && published && skuMatches && policiesMatch && !explicitlyUnavailable && validDisplayPrice(formattedPrice),
      availabilityMessage: !policiesMatch && published
        ? "Purchase terms changed. Reload after the storefront policy update is published."
        : product && typeof product.availabilityMessage === "string"
        ? product.availabilityMessage.trim().slice(0, 180)
        : ""
    };
  }

  function initializePurchasePage() {
    const form = byId("purchase-form");
    const purchaseButton = byId("purchase-button");
    const price = byId("catalog-price");
    const catalogStatus = byId("catalog-status");
    const checkoutStatus = byId("checkout-status");
    const retryButton = byId("retry-catalog");
    const acceptanceInputs = form ? Array.from(form.querySelectorAll("input[data-acceptance]")) : [];
    let catalogReady = false;
    let checkoutIdempotencyKey = "";

    function syncPurchaseButton() {
      const accepted = acceptanceInputs.every((input) => input.checked);
      purchaseButton.disabled = !catalogReady || !accepted;
    }

    async function loadCatalog() {
      catalogReady = false;
      syncPurchaseButton();
      setHidden(retryButton, true);
      price.textContent = "Checking availability…";
      setStatus(catalogStatus, "Confirming the currently published price with the license service.", "neutral");

      try {
        const payload = await apiRequest(config.paths.catalog);
        const catalog = normalizeCatalog(payload);
        if (!catalog.available) {
          price.textContent = "Purchase unavailable";
          setStatus(
            catalogStatus,
            catalog.availabilityMessage || "Checkout stays disabled until a published price is configured by the license service.",
            "warning"
          );
          return;
        }

        price.textContent = catalog.formattedPrice;
        catalogReady = true;
        setStatus(catalogStatus, "One-time v3 license. Any applicable tax is shown before payment.", "success");
      } catch (error) {
        price.textContent = "Purchase unavailable";
        setStatus(catalogStatus, error.message, "error");
        setHidden(retryButton, false);
      } finally {
        syncPurchaseButton();
      }
    }

    acceptanceInputs.forEach((input) => input.addEventListener("change", syncPurchaseButton));
    retryButton.addEventListener("click", loadCatalog);

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (!catalogReady || !acceptanceInputs.every((input) => input.checked)) {
        setStatus(checkoutStatus, "Review and accept each policy before continuing.", "warning");
        return;
      }

      setBusy(purchaseButton, true, "Opening secure checkout…");
      setStatus(checkoutStatus, "Creating a secure checkout session. No payment details pass through this site.", "neutral");

      try {
        checkoutIdempotencyKey = checkoutIdempotencyKey || createIdempotencyKey("checkout");
        const payload = await apiRequest(config.paths.checkoutSessions, {
          method: "POST",
          headers: { "Idempotency-Key": checkoutIdempotencyKey },
          body: {
            sku: config.productSku,
            policySetVersion: config.policySetVersion,
            acceptances: {
              terms: true,
              refunds: true,
              compatibility: true
            }
          }
        });
        const checkoutUrl = new URL(payload.checkoutUrl || payload.url || "");
        const allowedHost = checkoutUrl.protocol === "https:" && config.allowedCheckoutHosts.includes(checkoutUrl.hostname);
        if (!allowedHost) {
          throw new ApiError("The checkout service returned an unexpected destination. Please contact support.", 502);
        }

        checkoutIdempotencyKey = "";
        window.location.assign(checkoutUrl.toString());
      } catch (error) {
        setStatus(checkoutStatus, error.message, "error");
        setBusy(purchaseButton, false, "");
        syncPurchaseButton();
      }
    });

    loadCatalog();
  }

  function takeCheckoutSessionId() {
    const url = new URL(window.location.href);
    const sessionId = url.searchParams.get("session_id") || "";
    url.searchParams.delete("session_id");
    window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);

    return /^[A-Za-z0-9_]{8,255}$/.test(sessionId) ? sessionId : "";
  }

  async function initializeCheckoutSuccessPage() {
    const status = byId("payment-status");
    const heading = byId("payment-heading");
    const sessionId = takeCheckoutSessionId();

    if (!sessionId) {
      heading.textContent = "We are checking your order";
      setStatus(status, "No checkout reference was available. Check your receipt email or sign in to the license portal.", "warning");
      return;
    }

    setStatus(status, "Checking the server-confirmed payment state. This page does not grant licenses by itself.", "neutral");
    try {
      const payload = await apiRequest(`${config.paths.checkoutStatus}/${encodeURIComponent(sessionId)}`);
      const paymentStatus = String(payload.status || payload.paymentStatus || "processing").toLowerCase();
      const entitlementActive = payload.entitlementStatus === "active" || payload.entitlementActive === true;

      if (entitlementActive) {
        heading.textContent = "Your v3 license is ready";
        setStatus(status, "Payment and entitlement are confirmed. Use the email from checkout to sign in and approve your Mac.", "success");
      } else if (["paid", "complete", "completed", "fulfilled"].includes(paymentStatus)) {
        heading.textContent = "Payment received";
        setStatus(status, "Your payment is confirmed and the license service is finishing fulfillment. Check your email before retrying payment.", "success");
      } else if (["expired", "canceled", "cancelled", "unpaid"].includes(paymentStatus)) {
        heading.textContent = "Payment was not completed";
        setStatus(status, "No confirmed payment was found for this checkout. You can return to the product page when ready.", "warning");
      } else {
        heading.textContent = "Payment is processing";
        setStatus(status, "Some payment methods take longer to confirm. Check your email or the license portal before retrying.", "neutral");
      }
    } catch (error) {
      heading.textContent = "We are still checking your order";
      setStatus(status, error.message, "error");
    }
  }

  function takePortalLinkValues() {
    const url = new URL(window.location.href);
    const fragment = new URLSearchParams(url.hash.replace(/^#/, ""));
    const tokenHashInQuery = url.searchParams.has("token_hash");
    const tokenHash = fragment.get("token_hash") || "";
    const activationCode = url.searchParams.get("code") || fragment.get("code") || "";

    url.searchParams.delete("token_hash");
    url.searchParams.delete("code");
    url.hash = "";
    window.history.replaceState({}, "", `${url.pathname}${url.search}`);

    return { tokenHash, tokenHashInQuery, activationCode };
  }

  function validTokenHash(value) {
    return typeof value === "string" && /^[A-Za-z0-9_-]{32,256}$/.test(value);
  }

  function normalizeActivationCode(value) {
    return String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 16);
  }

  function createDeviceItem(device, refreshPortal) {
    const item = document.createElement("li");
    item.className = "device-item";

    const copy = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = device.name || device.label || "Mac";
    const details = document.createElement("p");
    const lastSeen = formatDate(device.lastSeenAt || device.lastSeen);
    const version = device.appVersion ? ` · Gesture Flow ${device.appVersion}` : "";
    details.textContent = `Last checked ${lastSeen}${version}`;
    copy.append(title, details);

    const button = document.createElement("button");
    button.type = "button";
    button.className = "button button-danger";
    button.textContent = "Deactivate";
    let deactivationIdempotencyKey = "";
    button.addEventListener("click", async () => {
      const confirmed = window.confirm(`Deactivate ${title.textContent}? The app will lose access at its next license check, no later than the 30-day offline limit.`);
      if (!confirmed) {
        return;
      }

      setBusy(button, true, "Deactivating…");
      try {
        deactivationIdempotencyKey = deactivationIdempotencyKey || createIdempotencyKey("deactivate");
        await apiRequest(`${config.paths.devices}/${encodeURIComponent(device.id)}/deactivate`, {
          method: "POST",
          headers: { "Idempotency-Key": deactivationIdempotencyKey },
          body: {}
        });
        deactivationIdempotencyKey = "";
        await refreshPortal("Device deactivated.", "success");
      } catch (error) {
        window.alert(error.message);
        setBusy(button, false, "");
      }
    });

    item.append(copy, button);
    return item;
  }

  function initializePortalPage() {
    const linkValues = takePortalLinkValues();
    const tokenHashWasInvalid = linkValues.tokenHashInQuery
      || (Boolean(linkValues.tokenHash) && !validTokenHash(linkValues.tokenHash));
    let tokenHash = validTokenHash(linkValues.tokenHash) ? linkValues.tokenHash : "";
    const loginSection = byId("portal-login");
    const exchangeSection = byId("portal-exchange");
    const accountSection = byId("portal-account");
    const portalStatus = byId("portal-status");
    const magicLinkForm = byId("magic-link-form");
    const magicLinkButton = byId("magic-link-button");
    const magicLinkStatus = byId("magic-link-status");
    const continueButton = byId("continue-magic-link");
    const signOutButton = byId("sign-out-button");
    const emailValue = byId("account-email");
    const entitlementValue = byId("entitlement-status");
    const deviceCount = byId("device-count");
    const deviceList = byId("device-list");
    const emptyDevices = byId("empty-devices");
    const activationForm = byId("activation-form");
    const activationInput = byId("activation-code");
    const activationButton = byId("activation-button");
    const activationStatus = byId("activation-status");
    const activationAcceptances = Array.from(document.querySelectorAll("input[data-activation-acceptance]"));
    const refundForm = byId("refund-form");
    const refundOrder = byId("refund-order");
    const refundButton = byId("refund-button");
    const refundStatus = byId("refund-status");
    let activationIdempotencyKey = "";
    let refundIdempotencyKey = "";
    let refundBusy = false;

    activationInput.value = normalizeActivationCode(linkValues.activationCode);

    function showSignedOut() {
      setHidden(accountSection, true);
      setHidden(loginSection, false);
      setHidden(exchangeSection, !tokenHash);
    }

    function syncRefundButton() {
      refundButton.disabled = refundBusy || refundOrder.disabled || !refundOrder.value;
    }

    function renderRefundOrders(payload) {
      const orders = Array.isArray(payload.orders) ? payload.orders : [];
      const refundRequests = Array.isArray(payload.refundRequests) ? payload.refundRequests : [];
      const openRequestOrderIds = new Set(
        refundRequests
          .filter((request) => ["requested", "reviewing", "approved"].includes(request.status))
          .map((request) => request.order_id)
      );
      const now = Date.now();
      const eligibleOrders = orders.filter((order) => {
        const eligibleUntil = new Date(order.refund_eligible_until).getTime();
        return typeof order.id === "string" &&
          ["paid", "suspended_refund"].includes(order.status) &&
          Number.isFinite(eligibleUntil) && eligibleUntil >= now &&
          !openRequestOrderIds.has(order.id);
      });

      refundOrder.replaceChildren();
      const placeholder = document.createElement("option");
      placeholder.value = "";
      placeholder.textContent = eligibleOrders.length
        ? "Choose the exact purchase"
        : "No purchase is currently eligible online";
      refundOrder.append(placeholder);

      for (const order of eligibleOrders) {
        const option = document.createElement("option");
        option.value = order.id;
        option.textContent = `${formatDate(order.paid_at)} · ${
          formatMoney(order.amount_total, order.currency)
        } · Order ${order.id.slice(0, 8)}`;
        refundOrder.append(option);
      }
      refundOrder.disabled = eligibleOrders.length === 0;
      syncRefundButton();
    }

    function renderPortal(payload) {
      const account = payload.account || payload.customer || {};
      const entitlement = payload.entitlement || (Array.isArray(payload.entitlements) ? payload.entitlements[0] : null);
      const devices = Array.isArray(payload.devices) ? payload.devices : [];
      const reportedDeviceLimit = Number(payload.deviceAllowance?.limit);
      const deviceLimit = Number.isInteger(reportedDeviceLimit) && reportedDeviceLimit >= 0
        ? reportedDeviceLimit
        : entitlement
          ? 2
          : 0;
      const entitlementLabel = entitlement
        ? entitlement.displayStatus || entitlement.status || "Active v3 entitlement"
        : payload.trialEligible
          ? "Eligible for the one-time 14-day trial"
          : "No active v3 entitlement";

      emailValue.textContent = account.email || "Signed-in customer";
      entitlementValue.textContent = entitlementLabel;
      deviceCount.textContent = deviceLimit > 0
        ? `${devices.length} of ${deviceLimit} device slots in use`
        : payload.trialEligible
          ? "Two device slots become available when the trial starts"
          : "No active device allowance";
      deviceList.replaceChildren();
      devices.forEach((device) => deviceList.append(createDeviceItem(device, loadPortal)));
      setHidden(emptyDevices, devices.length !== 0);
      renderRefundOrders(payload);
      setHidden(loginSection, true);
      setHidden(exchangeSection, true);
      setHidden(accountSection, false);
    }

    async function loadPortal(successMessage, successTone) {
      setStatus(portalStatus, successMessage || "Loading your secure license account…", successTone || "neutral");
      try {
        const payload = await apiRequest(config.paths.me);
        renderPortal(payload);
        if (successMessage) {
          setStatus(portalStatus, successMessage, successTone || "success");
        } else {
          setStatus(portalStatus, "", "neutral");
        }
      } catch (error) {
        if (error.status === 401) {
          csrfToken = "";
          showSignedOut();
          setStatus(
            portalStatus,
            tokenHashWasInvalid ? "This sign-in link is malformed. Request a new link instead of retrying it." : "",
            tokenHashWasInvalid ? "warning" : "neutral"
          );
        } else {
          showSignedOut();
          setStatus(portalStatus, error.message, "error");
        }
      }
    }

    magicLinkForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const email = String(new FormData(magicLinkForm).get("email") || "").trim();
      setBusy(magicLinkButton, true, "Sending link…");
      setStatus(magicLinkStatus, "Requesting a one-time sign-in link…", "neutral");
      try {
        await apiRequest(config.paths.magicLink, {
          method: "POST",
          body: { email }
        });
        magicLinkForm.reset();
        setStatus(magicLinkStatus, "If that email can use the portal, a one-time link is on its way. Check spam before requesting another.", "success");
      } catch (error) {
        setStatus(magicLinkStatus, error.message, "error");
      } finally {
        setBusy(magicLinkButton, false, "");
      }
    });

    continueButton.addEventListener("click", async () => {
      if (!tokenHash) {
        setStatus(portalStatus, "This sign-in link is missing or already used. Request another link.", "warning");
        return;
      }

      setBusy(continueButton, true, "Signing in…");
      setStatus(portalStatus, "Exchanging the one-time link for a secure browser session…", "neutral");
      try {
        await apiRequest(config.paths.session, {
          method: "POST",
          body: { tokenHash, type: "email" }
        });
        tokenHash = "";
        await loadPortal("Signed in securely.", "success");
      } catch (error) {
        setStatus(portalStatus, error.message, "error");
        setBusy(continueButton, false, "");
      }
    });

    signOutButton.addEventListener("click", async () => {
      setBusy(signOutButton, true, "Signing out…");
      try {
        await apiRequest(config.paths.session, { method: "DELETE" });
      } catch (error) {
        if (error.status !== 401) {
          setStatus(portalStatus, error.message, "error");
          setBusy(signOutButton, false, "");
          return;
        }
      }

      csrfToken = "";
      showSignedOut();
      setBusy(signOutButton, false, "");
      setStatus(portalStatus, "Signed out.", "success");
    });

    activationInput.addEventListener("input", () => {
      activationInput.value = normalizeActivationCode(activationInput.value);
    });

    function syncActivationButton() {
      activationButton.disabled = !activationAcceptances.every((input) => input.checked);
    }

    activationAcceptances.forEach((input) => input.addEventListener("change", syncActivationButton));
    syncActivationButton();

    activationForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const code = normalizeActivationCode(activationInput.value);
      if (code.length < 6) {
        setStatus(activationStatus, "Enter the code shown by Gesture Flow on the Mac you control.", "warning");
        return;
      }
      if (!activationAcceptances.every((input) => input.checked)) {
        setStatus(activationStatus, "Review and accept both activation acknowledgements.", "warning");
        return;
      }

      setBusy(activationButton, true, "Approving Mac…");
      setStatus(activationStatus, "Approving this device. This uses your paid v3 entitlement or starts your one-time trial if eligible.", "neutral");
      try {
        activationIdempotencyKey = activationIdempotencyKey || createIdempotencyKey("activation");
        const payload = await apiRequest(`${config.paths.activationApprovals}/${encodeURIComponent(code)}/approve`, {
          method: "POST",
          headers: { "Idempotency-Key": activationIdempotencyKey },
          body: {
            policySetVersion: config.policySetVersion,
            acceptances: {
              terms: true,
              compatibility: true
            }
          }
        });
        activationIdempotencyKey = "";
        activationForm.reset();
        const message = payload.trialStarted
          ? "Mac approved. Your one-time 14-day trial has started."
          : "Mac approved. Return to Gesture Flow to finish activation.";
        setStatus(activationStatus, message, "success");
        await loadPortal();
      } catch (error) {
        setStatus(activationStatus, error.message, "error");
      } finally {
        setBusy(activationButton, false, "");
        syncActivationButton();
      }
    });

    refundForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const formData = new FormData(refundForm);
      const orderId = String(formData.get("orderId") || "");
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(orderId)) {
        setStatus(refundStatus, "Choose the exact purchase you want reviewed.", "warning");
        return;
      }
      if (formData.get("refundAcknowledgement") !== "accepted") {
        setStatus(refundStatus, "Confirm that you understand the license effect before submitting.", "warning");
        return;
      }

      refundBusy = true;
      setBusy(refundButton, true, "Submitting request…");
      setStatus(refundStatus, "Submitting your request for server-side eligibility review…", "neutral");
      try {
        refundIdempotencyKey = refundIdempotencyKey || createIdempotencyKey("refund");
        await apiRequest(config.paths.refundRequests, {
          method: "POST",
          headers: { "Idempotency-Key": refundIdempotencyKey },
          body: {
            sku: config.productSku,
            orderId,
            reason: String(formData.get("reason") || ""),
            details: String(formData.get("details") || "").trim().slice(0, 1000),
            licenseRevocationAcknowledged: true
          }
        });
        refundIdempotencyKey = "";
        refundForm.reset();
        setStatus(refundStatus, "Refund request received. We will reply by email after reviewing eligibility; submitting does not itself confirm a refund.", "success");
        await loadPortal();
      } catch (error) {
        setStatus(refundStatus, error.message, "error");
      } finally {
        refundBusy = false;
        setBusy(refundButton, false, "");
        syncRefundButton();
      }
    });

    refundForm.addEventListener("input", () => {
      refundIdempotencyKey = "";
      syncRefundButton();
    });

    showSignedOut();
    loadPortal();
  }

  const page = document.body.dataset.page;
  if (page === "purchase") {
    initializePurchasePage();
  } else if (page === "checkout-success") {
    initializeCheckoutSuccessPage();
  } else if (page === "portal") {
    initializePortalPage();
  }
})();
