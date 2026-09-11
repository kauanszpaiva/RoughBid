# DocuSign Account Swap Operational Runbook

This document details the exact operational procedure for transitioning BEZ Member Hub from DocuSign Account A to DocuSign Account B without modifying application business logic or invalidating canonical BEZ contract hashes.

> **SECURITY MANDATE:** NEVER commit private keys, RSA key strings, HMAC secrets, or access tokens into repository files or operational logs. Use placeheld environment variable names only.

---

## Prerequisites & Overview

BEZ Member Hub uses DocuSign **only** for CUSTOM contract agreements. STANDARD contracts use the internal BEZ signing flow.

The BEZ Contract Engine is the canonical source of truth for:
* Contract templates & versions
* Commercial data & content hashes (`templateContentHash`)
* Contract state & immutable frozen snapshots

DocuSign operates purely as an external signature provider adapter.

---

## Operational Step-by-Step Procedure

### Step 1: Create or Select Target Integration App
1. Log into the target DocuSign Admin console (Demo or Production).
2. Navigate to **Settings** > **Apps and Keys**.
3. Create a new App / Integration Key (e.g., `BEZ Member Hub Signature Adapter`).
4. Note the generated **Integration Key** (Client ID).

### Step 2: Configure OAuth / JWT User & Keypair
1. Under the App configuration, generate an RSA Keypair.
2. Store the Private Key securely in your secrets vault (e.g., Vercel / Secret Manager).
3. Assign/Identify an Integration User ID (`DOCUSIGN_USER_ID`) dedicated to automated API calls.

### Step 3: Grant Required Administrative Consent
1. Construct the DocuSign OAuth consent URL:
   `https://<auth-server>/oauth/auth?response_type=code&scope=signature%20impersonation&client_id=<INTEGRATION_KEY>&redirect_uri=<REDIRECT_URI>`
2. Open the URL in an admin browser session logged into the target DocuSign account.
3. Grant consent for the integration application.

### Step 4: Capture Account ID & Base URI (or Enable Discovery)
Option A (Explicit Configuration):
* Retrieve **API Account ID** and **Account Base URI** from **Apps and Keys**.
* Set `DOCUSIGN_ACCOUNT_ID=<your-account-id>` and `DOCUSIGN_BASE_URI=<your-base-uri>`.

Option B (Secure Automatic Discovery):
* Omit `DOCUSIGN_ACCOUNT_ID` and `DOCUSIGN_BASE_URI`. The provider adapter will query `/oauth/userinfo` at startup/resolution.

### Step 5: Create / Mirror Approved DocuSign Template
1. Create a template in DocuSign Account B corresponding to the approved BEZ Custom Agreement.
2. Ensure the document content matches the canonical BEZ template version.
3. Note the newly generated DocuSign Template ID.

### Step 6: Configure Member & BEZ Roles
1. In the DocuSign Template settings, define exactly two Recipient Roles:
   * Role 1: `Member` (or custom name configured via `DOCUSIGN_MEMBER_ROLE_NAME`)
   * Role 2: `BEZ Authorized Signer` (or custom name configured via `DOCUSIGN_BEZ_SIGNER_ROLE_NAME`)

### Step 7: Certify Tabs & Form Fields
1. Add required Anchor Tabs / Sign Tags for both recipients (`\s1\`, `\d1\`, `\s2\`, `\d2\`).
2. Mark template tabs as certified and ready for automated envelope generation.
3. Set environment variable: `DOCUSIGN_TEMPLATES_CERTIFIED=true`.

### Step 8: Configure Template-Hash to Template-ID Mapping
1. Obtain the canonical BEZ contract content hash (e.g., `sha256-hash-of-canonical-bez-contract`).
2. Construct the JSON mapping string:
   ```json
   DOCUSIGN_BEZ_TEMPLATE_MAP_JSON='{"sha256-hash-of-canonical-bez-contract":"docusign-template-id-in-account-b"}'
   ```
3. *Note: Changing DocuSign accounts NEVER changes the canonical BEZ contract hash.*

### Step 9: Configure Connect Webhook
1. In DocuSign Admin, navigate to **Connect** > **Add Configuration** > **Custom**.
2. Set the Webhook URL to: `https://<bez-domain>/api/webhooks/docusign` (or environment `DOCUSIGN_WEBHOOK_URL`).
3. Select trigger events: Envelope Signed, Envelope Completed, Envelope Voided/Declined.

### Step 10: Configure HMAC Secret
1. Under the Connect configuration, enable **HMAC Security**.
2. Generate/retrieve an HMAC Secret Key.
3. Set environment variable: `DOCUSIGN_HMAC_SECRET_KEY=<your-hmac-secret-key>`.

### Step 11: Configure BEZ Legal Signer Identity
Separate DocuSign account identity from BEZ Legal Signer identity:
* Set `BEZ_LEGAL_SIGNER_NAME="Authorized BEZ Representative"`
* Set `BEZ_LEGAL_SIGNER_EMAIL="legal@bezdomain.com"`

### Step 12: Run Read-Only Health Diagnostics
1. Execute the diagnostic check via backend endpoint or `docusignStatus()`.
2. Ensure status output reports:
   - `credentialsConfigured`: `true`
   - `accountResolved`: `true`
   - `canonicalTemplateMappingConfigured`: `true`
   - `legalSignerConfigured`: `true`
   - `prepareAllowed`: `true`
3. Verify that zero private keys, access tokens, or HMAC secret values are returned in diagnostic output.

### Step 13: Prepare a Sandbox / Dry-Run Envelope
1. Trigger a prepare request for a CUSTOM contract type.
2. Confirm the adapter resolves the new DocuSign Template ID and account endpoints.

### Step 14: Verify Recipient Binding
1. Inspect the dry-run recipient roles to verify:
   - Member recipient is assigned to `DOCUSIGN_MEMBER_ROLE_NAME`
   - BEZ legal signer recipient is assigned to `DOCUSIGN_BEZ_SIGNER_ROLE_NAME` with `BEZ_LEGAL_SIGNER_EMAIL`

### Step 15: Enable Real-Send Gate
1. Once dry-run verification is successful, enable sending:
   ```env
   DOCUSIGN_ALLOW_REAL_SEND=true
   ```
2. Real DocuSign envelopes will now dispatch to Account B.
