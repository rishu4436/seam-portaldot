// A software stand-in for the polkadot.js extension, for tests and dry runs. Same surface the page uses:
// window.injectedWeb3['polkadot-js'].enable(name) -> { accounts.get(), signer.signPayload(payload) }.
// Like the real extension it signs the SCALE payload (hashed when over 256 bytes) and returns a typed signature.
import { Keyring } from "@polkadot/keyring";
import { cryptoWaitReady } from "@polkadot/util-crypto";
import { u8aToHex, hexToU8a } from "@polkadot/util";
import { TypeRegistry } from "@polkadot/types";
import { blake2AsU8a } from "@polkadot/util-crypto";

export async function softwareExtension(
  uri,
  { scheme = "sr25519", ss58 = 42, decline = () => false } = {},
) {
  await cryptoWaitReady();
  const pair = new Keyring({ type: scheme, ss58Format: ss58 }).addFromUri(uri);
  const registry = new TypeRegistry();
  const seen = [];
  return {
    seen,
    injectedWeb3: {
      "polkadot-js": {
        enable: async () => ({
          accounts: { get: async () => [{ address: pair.address, name: "software" }] },
          signer: {
            async signPayload(payload) {
              seen.push(payload);
              if (decline(payload)) throw new Error("Cancelled");
              registry.setSignedExtensions(payload.signedExtensions);
              const raw = registry
                .createType("ExtrinsicPayload", payload, { version: payload.version })
                .toU8a({ method: true });
              const bytes = raw.length > 256 ? blake2AsU8a(raw, 256) : raw;
              return { id: seen.length, signature: u8aToHex(pair.sign(bytes, { withType: true })) };
            },
          },
        }),
      },
    },
  };
}
void hexToU8a;
