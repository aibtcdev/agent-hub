import bitcoinMessage from "bitcoinjs-message";

/**
 * Verify a BIP-137 signed message.
 *
 * For registration: the agent signs their own Stacks address with their
 * Bitcoin key. The hub verifies the signature matches the claimed Bitcoin address.
 *
 * For authenticated requests: the agent signs the request body (JSON string)
 * with their Bitcoin key.
 */
export function verifyBip137(
  message: string,
  bitcoinAddress: string,
  signature: string
): boolean {
  try {
    return bitcoinMessage.verify(message, bitcoinAddress, signature);
  } catch {
    return false;
  }
}

/**
 * Extract and verify auth from request headers.
 * Expects:
 *   X-Agent-Address: <stacks-address>
 *   X-Signature: <base64-bip137-signature-of-body>
 *   X-Bitcoin-Address: <bitcoin-address>
 */
export type AuthResult =
  | { ok: true; agentAddress: string; bitcoinAddress: string }
  | { ok: false; error: string };

export function extractAuth(
  headers: Headers,
  body: string
): AuthResult {
  const agentAddress = headers.get("x-agent-address");
  const signature = headers.get("x-signature");
  const bitcoinAddress = headers.get("x-bitcoin-address");

  if (!agentAddress || !signature || !bitcoinAddress) {
    return {
      ok: false,
      error: "Missing required headers: X-Agent-Address, X-Signature, X-Bitcoin-Address",
    };
  }

  const valid = verifyBip137(body, bitcoinAddress, signature);
  if (!valid) {
    return { ok: false, error: "Invalid BIP-137 signature" };
  }

  return { ok: true, agentAddress, bitcoinAddress };
}
