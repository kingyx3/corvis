import assert from "node:assert/strict";
import test from "node:test";
import {
  CONNECTION_STATUSES,
  CONNECTOR_ERROR_CLASSES,
  CONNECTOR_ERROR_COPY,
  CREDENTIAL_TYPES,
  describeConnection,
  type SourceConnectionStatus,
  type SourceConnectorErrorClass,
  type SourceCredentialType,
} from "../../core/source-connection-health.ts";
import { isFailClosedErrorClass, isRetryableErrorClass, statusAfterError, type ConnectionStatus, type ConnectorErrorClass, type CredentialType } from "./source-connectors.ts";

// Compile-time lock: if either side gains or loses a member, one of these assignments stops type-checking
// (`npm run typecheck`), so the customer-facing copy in src/core/ can never silently lag the server's enums.
type Mutual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const statusesMatch: Mutual<SourceConnectionStatus, ConnectionStatus> = true;
const errorClassesMatch: Mutual<SourceConnectorErrorClass, ConnectorErrorClass> = true;
const credentialTypesMatch: Mutual<SourceCredentialType, CredentialType> = true;

test("core's connection vocabulary is the server's, member for member", () => {
  assert.deepEqual([statusesMatch, errorClassesMatch, credentialTypesMatch], [true, true, true]);
  // Runtime guard for the same property: the server's own classification helpers must accept exactly these classes.
  for (const errorClass of CONNECTOR_ERROR_CLASSES) {
    assert.equal(isFailClosedErrorClass(errorClass) !== isRetryableErrorClass(errorClass), true, `${errorClass} is exactly one of fail-closed or retryable`);
  }
});

test("customer copy treats exactly the server's retryable classes as transient", () => {
  for (const errorClass of CONNECTOR_ERROR_CLASSES) {
    assert.equal(CONNECTOR_ERROR_COPY[errorClass].transient, isRetryableErrorClass(errorClass), errorClass);
    assert.equal(CONNECTOR_ERROR_COPY[errorClass].action.kind === "wait", isRetryableErrorClass(errorClass), `${errorClass}: only retryable classes tell the customer to wait`);
  }
});

test("the status the server drives a failed sync to is the status the health model explains", () => {
  const reauthorizing: ConnectorErrorClass[] = ["auth", "reauthorization"];
  for (const errorClass of CONNECTOR_ERROR_CLASSES) {
    const status = statusAfterError("active", errorClass, 1);
    const health = describeConnection({
      sourceConnectionId: "c", connectionLabel: "Acme", credentialType: "scoped_api_token", sourceScope: [{ label: "Reports" }],
      status, consecutiveFailures: 1, lastErrorClass: errorClass, lastSuccessAt: new Date().toISOString(), lastAttemptAt: new Date().toISOString(),
    });
    const expectedSeverity = reauthorizing.includes(errorClass) ? "reauthorization"
      : errorClass === "permission" || errorClass === "provider_change" ? "suspended"
        : isRetryableErrorClass(errorClass) ? "transient" : "attention";
    assert.equal(health.severity, expectedSeverity, errorClass);
    assert.equal(health.error?.summary, CONNECTOR_ERROR_COPY[errorClass].summary, errorClass);
  }
  assert.deepEqual(CONNECTION_STATUSES.length, 6);
  assert.deepEqual(CREDENTIAL_TYPES.length, 5);
});
