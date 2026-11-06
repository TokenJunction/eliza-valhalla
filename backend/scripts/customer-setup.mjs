const names = [
  "CUSTOMER_ADMIN_EMAIL",
  "MASTER_ADMIN_EMAIL",
  "LEADER_EMAIL",
  "SESSION_SECRET",
  "SETUP_MASTER_KEY",
  "VALHALLA_SIGNING_PRIVATE_KEY",
  "VALHALLA_SIGNING_PUBLIC_KEY",
  "VALHALLA_LICENSE_PUBLIC_KEY",
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "UPSTASH_REDIS_URL",
  "GEMINI_API_KEY",
  "DEEPSEEK_API_KEY",
  "XAI_API_KEY",
  "OPENAI_API_KEY",
  "LEMON_WEBHOOK_SECRET",
  "NOWPAYMENTS_API_KEY",
  "NOWPAYMENTS_IPN_SECRET",
  "COINBASE_COMMERCE_API_KEY",
  "COINBASE_COMMERCE_WEBHOOK_SECRET",
];

console.log("ValhallaOS customer setup. This script does not create hosted accounts and does not print secret values.");
console.log("Create your own Render service, database, Redis, and model accounts. Point DNS yourself.");
for (const name of names) {
  console.log(`${name}: ${process.env[name] ? "set" : "missing"}`);
}
console.log("Set VALHALLA_FACTORY=1 only on the factory deployment. Leave it unset for a customer.");
console.log("Ollama must be an https URL you own. http://127.0.0.1 is rejected.");
