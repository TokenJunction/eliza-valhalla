import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { generateEd25519, toPem } from "../ed25519.js";

const out = process.env.KEY_OUT || new URL("../data/signing-key.pem", import.meta.url);
const pub = process.env.PUB_OUT || new URL("../data/signing-key.pub.pem", import.meta.url);
const pair = generateEd25519();
mkdirSync(dirname(out.pathname || "."), { recursive: true });
writeFileSync(out, toPem(pair.privateKey, "pkcs8"), { mode: 0o600 });
writeFileSync(pub, toPem(pair.publicKey, "spki"), { mode: 0o644 });
console.log("Wrote signing key files. They are gitignored. Do not commit them.");
