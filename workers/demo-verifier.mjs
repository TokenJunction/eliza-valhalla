/**
 * Print a demo password verifier. Read the password from stdin.
 * Do not pass the password as an argument. Do not save the password in the Worker.
 * Set the printed line as the preview secret DEMO_VERIFIER.
 */
import { createVerifier } from "./demo-auth.mjs";

if (process.argv.length > 2) {
  process.stderr.write("Pass the password on stdin. Do not put it in the command.\n");
  process.exit(1);
}

var chunks = [];
for await (var chunk of process.stdin) chunks.push(chunk);
var password = Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
try {
  var verifier = await createVerifier(password);
  process.stdout.write(verifier + "\n");
} catch (err) {
  process.stderr.write("The verifier was not created.\n");
  process.exit(1);
}
