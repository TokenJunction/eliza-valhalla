"use strict";

function normalize(email) {
  return String(email || "").trim().toLowerCase();
}

function verifiedAdminEmails(env) {
  const factory = String(env && env.VALHALLA_FACTORY) === "1";
  const keys = factory ? ["MASTER_ADMIN_EMAIL", "LEADER_EMAIL"] : ["CUSTOMER_ADMIN_EMAIL"];
  const out = [];
  for (const key of keys) {
    const email = normalize(env && env[key]);
    if (email && !out.includes(email)) out.push(email);
  }
  return out;
}

function isServerVerifiedAdmin(env, session) {
  if (!session || session.google !== true || session.code !== true) return false;
  const email = normalize(session.email);
  if (!email) return false;
  return verifiedAdminEmails(env).includes(email);
}

module.exports = { normalize, verifiedAdminEmails, isServerVerifiedAdmin };
