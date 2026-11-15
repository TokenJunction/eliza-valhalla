/**
 * Account-bound sign-in store.
 * One object is named with the mailbox hash. Another request cannot write that account.
 * Call the methods on the stub from env.AUTH_DO.get(id). There is no fetch route.
 * AUTH_KV stays on the worker for chat settings, engagement counts, and rate limits.
 */
var HEX = /^[0-9a-f]{64}$/;
var SID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
var UID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
var IDLE_MS = 30 * 60 * 1000;

function coded(error) {
  var err = new Error(error);
  err.code = error;
  return err;
}

function safeEqual(left, right) {
  var a = String(left || "");
  var b = String(right || "");
  if (a.length !== b.length) return false;
  var diff = 0;
  for (var i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function sha256Hex(text) {
  var buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(text)));
  return [...new Uint8Array(buf)].map(function (b) { return b.toString(16).padStart(2, "0"); }).join("");
}

function blankAccount() {
  return { devices: [], ips: [], signins: [], alwaysAsk: false, plan: "" };
}

export class AuthDurableObject {
  constructor(ctx) {
    this.ctx = ctx;
    this.queue = Promise.resolve();
    this.ready = this.enqueue(() => this.migrate());
  }

  enqueue(fn) {
    var run = this.queue.then(function () { return fn(); });
    this.queue = run.then(function () { return undefined; }, function () { return undefined; });
    return run;
  }

  sql() {
    return this.ctx.storage.sql;
  }

  migrate() {
    var sql = this.sql();
    sql.exec("CREATE TABLE IF NOT EXISTS account (eh TEXT PRIMARY KEY, body TEXT NOT NULL)");
    sql.exec("CREATE TABLE IF NOT EXISTS sessions (sid TEXT PRIMARY KEY, eh TEXT NOT NULL, uid TEXT NOT NULL, did TEXT NOT NULL, exp INTEGER NOT NULL, v INTEGER NOT NULL, code INTEGER NOT NULL, google INTEGER NOT NULL, purpose TEXT NOT NULL, last_seen INTEGER NOT NULL)");
    sql.exec("CREATE TABLE IF NOT EXISTS login_code (eh TEXT PRIMARY KEY, hash TEXT NOT NULL, salt TEXT NOT NULL, attempts INTEGER NOT NULL, exp INTEGER NOT NULL, google_verified INTEGER NOT NULL, uid TEXT NOT NULL, hint TEXT NOT NULL)");
    sql.exec("CREATE TABLE IF NOT EXISTS nonces (id TEXT PRIMARY KEY, exp INTEGER NOT NULL, used INTEGER NOT NULL)");
    sql.exec("CREATE TABLE IF NOT EXISTS humans (id TEXT PRIMARY KEY, eh TEXT NOT NULL, provider TEXT NOT NULL)");
    sql.exec("CREATE TABLE IF NOT EXISTS revoked_devices (did TEXT PRIMARY KEY, eh TEXT NOT NULL)");
    sql.exec("CREATE TABLE IF NOT EXISTS demo_lock (id TEXT PRIMARY KEY, fails INTEGER NOT NULL, locked_until INTEGER NOT NULL)");
  }

  async tx(fn) {
    var storage = this.ctx.storage;
    if (typeof storage.transaction === "function") return storage.transaction(fn);
    return fn();
  }

  first(query, ...params) {
    var cursor = this.sql().exec(query, ...params);
    var list = cursor && typeof cursor.toArray === "function" ? cursor.toArray() : [];
    return list && list.length ? list[0] : null;
  }

  accountRow() {
    return this.first("SELECT eh, body FROM account");
  }

  requireEh(eh) {
    if (!HEX.test(String(eh || ""))) throw coded("eh");
    var row = this.accountRow();
    if (row && row.eh !== eh) throw coded("eh");
    return row;
  }

  readBody(row) {
    if (!row) return blankAccount();
    try {
      var body = JSON.parse(row.body);
      body.eh = row.eh;
      body.alwaysAsk = body.alwaysAsk === true;
      body.role = body.role === "demo" ? "demo" : "";
      body.demoId = body.role === "demo" && String(body.demoId || "").indexOf("demo:") === 0 ? String(body.demoId) : "";
      body.devices = Array.isArray(body.devices) ? body.devices : [];
      body.ips = Array.isArray(body.ips) ? body.ips : [];
      body.signins = Array.isArray(body.signins) ? body.signins : [];
      return body;
    } catch (err) {
      throw coded("account");
    }
  }

  writeBody(eh, account) {
    var body = {
      devices: (account.devices || []).slice(0, 20),
      ips: (account.ips || []).slice(0, 10),
      signins: (account.signins || []).slice(0, 20),
      alwaysAsk: account.alwaysAsk === true,
      role: account.role === "demo" ? "demo" : "",
      demoId: account.role === "demo" && String(account.demoId || "").indexOf("demo:") === 0 ? String(account.demoId) : "",
      plan: account.role === "demo" ? "" : (typeof account.plan === "string" ? account.plan : "")
    };
    var json = JSON.stringify(body);
    var row = this.accountRow();
    if (row && row.eh !== eh) throw coded("eh");
    if (!row) this.sql().exec("INSERT INTO account (eh, body) VALUES (?, ?)", eh, json);
    else this.sql().exec("UPDATE account SET body = ? WHERE eh = ?", json, eh);
  }

  bindUid(eh, uid, provider) {
    if (!uid) return;
    if (!UID.test(String(uid)) || provider !== "google") throw coded("uid");
    var human = this.first("SELECT id, eh, provider FROM humans WHERE id = ?", uid);
    if (human && (human.eh !== eh || human.provider !== "google")) throw coded("uid");
    if (!human) this.sql().exec("INSERT INTO humans (id, eh, provider) VALUES (?, ?, ?)", uid, eh, "google");
  }

  async getAccount(eh) {
    var self = this;
    return this.enqueue(async function () {
      await self.ready;
      if (!HEX.test(String(eh || ""))) return null;
      var row = self.accountRow();
      if (row && row.eh !== eh) return null;
      var body = self.readBody(row);
      body.eh = row ? row.eh : eh;
      return body;
    });
  }

  async saveAccount(eh, account) {
    var self = this;
    return this.enqueue(async function () {
      await self.ready;
      try {
        return await self.tx(async function () {
          self.requireEh(eh);
          self.writeBody(eh, account || {});
          return { ok: true };
        });
      } catch (err) {
        if (err && err.code) return { ok: false, error: err.code };
        throw err;
      }
    });
  }

  async putSession(record) {
    var self = this;
    return this.enqueue(async function () {
      await self.ready;
      try {
        return await self.tx(async function () {
          return self.insertSessions(record || {});
        });
      } catch (err) {
        var known = err && (err.code === "eh" || err.code === "uid" || err.code === "sid" || err.code === "use" || err.code === "revoked" || err.code === "expired");
        if (known) return { ok: false, error: err.code };
        if (err && /UNIQUE/i.test(String(err.message || ""))) return { ok: false, error: "sid" };
        throw err;
      }
    });
  }

  insertSessions(record) {
    var sessions = Array.isArray(record.sessions) ? record.sessions : [record];
    var eh = String(record.eh || (sessions[0] && sessions[0].eh) || "");
    this.requireEh(eh);
    if (record.account) this.writeBody(eh, record.account);
    else if (!this.accountRow()) this.writeBody(eh, blankAccount());
    if (record.single === true) this.sql().exec("DELETE FROM sessions WHERE eh = ?", eh);
    var replaced = {};
    var stored = [];
    for (var i = 0; i < sessions.length; i += 1) {
      var did = sessions[i] && sessions[i].did;
      if (did && !replaced[did]) {
        this.sql().exec("DELETE FROM sessions WHERE eh = ? AND did = ?", eh, did);
        replaced[did] = true;
      }
      stored.push(this.insertOne(eh, sessions[i]));
    }
    return { ok: true, sessions: stored };
  }

  insertOne(eh, session) {
    if (!session || String(session.eh || "") !== eh) throw coded("eh");
    if (!SID.test(String(session.sid || "")) || !SID.test(String(session.did || ""))) throw coded("sid");
    var purpose = session.use === "device" ? "device" : session.use === "access" ? "access" : "";
    if (!purpose) throw coded("use");
    var uid = String(session.uid || "");
    var google = session.google === true;
    if (google) {
      if (!UID.test(uid)) throw coded("uid");
      this.bindUid(eh, uid, "google");
    } else if (uid) throw coded("uid");
    var revoked = this.first("SELECT did, eh FROM revoked_devices WHERE did = ?", session.did);
    if (revoked && revoked.eh === eh) throw coded("revoked");
    if (revoked && revoked.eh !== eh) throw coded("eh");
    var exp = Number(session.exp);
    var now = Date.now();
    if (!Number.isFinite(exp) || exp < now) throw coded("expired");
    var row = {
      sid: String(session.sid),
      eh: eh,
      uid: uid,
      did: String(session.did),
      exp: exp,
      v: Number(session.v) || 1,
      code: session.code === true ? 1 : 0,
      google: google ? 1 : 0,
      purpose: purpose,
      last_seen: now
    };
    this.sql().exec(
      "INSERT INTO sessions (sid, eh, uid, did, exp, v, code, google, purpose, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      row.sid, row.eh, row.uid, row.did, row.exp, row.v, row.code, row.google, row.purpose, row.last_seen
    );
    return { sid: row.sid, eh: row.eh, did: row.did, use: row.purpose };
  }

  async readSession(claims, now) {
    var self = this;
    return this.enqueue(async function () {
      await self.ready;
      var clock = Number.isFinite(now) ? now : Date.now();
      try {
        return await self.tx(async function () {
          return self.loadSession(claims || {}, clock);
        });
      } catch (err) {
        if (err && err.code) return null;
        throw err;
      }
    });
  }

  loadSession(claims, now) {
    var eh = String(claims.eh || "");
    var rowAccount = this.requireEh(eh);
    if (!rowAccount || rowAccount.eh !== eh) return null;
    var sid = String(claims.sid || "");
    var record = this.first("SELECT sid, eh, uid, did, exp, v, code, google, purpose, last_seen FROM sessions WHERE sid = ?", sid);
    if (!record) return null;
    if (record.eh !== eh || record.eh !== rowAccount.eh) return null;
    if (String(record.did) !== String(claims.did || "")) return null;
    if (Number(record.v) !== Number(claims.sv)) return null;
    if (Number(record.exp) !== Number(claims.exp)) return null;
    if ((record.code === 1) !== (claims.code === true)) return null;
    if ((record.google === 1) !== (claims.google === true)) return null;
    if (String(record.purpose) !== String(claims.use || "")) return null;
    if (String(record.uid || "") !== String(claims.uid || "")) return null;
    if (record.google === 1 && !UID.test(String(record.uid || ""))) return null;
    var account = this.readBody(rowAccount);
    var role = account.role === "demo" ? "demo" : "";
    if (String(claims.role || "") !== role) return null;
    var revoked = this.first("SELECT did FROM revoked_devices WHERE did = ? AND eh = ?", record.did, eh);
    if (revoked) return null;
    if (Number(record.exp) < now) {
      this.sql().exec("DELETE FROM sessions WHERE sid = ?", sid);
      return null;
    }
    if (now - Number(record.last_seen) > IDLE_MS) {
      this.sql().exec("DELETE FROM sessions WHERE sid = ?", sid);
      return null;
    }
    this.sql().exec("UPDATE sessions SET last_seen = ? WHERE sid = ? AND eh = ?", now, sid, eh);
    return {
      eh: record.eh,
      uid: record.uid || "",
      did: record.did,
      sid: record.sid,
      exp: Number(record.exp),
      sv: Number(record.v),
      code: record.code === 1,
      google: record.google === 1,
      role: role,
      use: record.purpose
    };
  }

  async demoStrike(action, now) {
    var self = this;
    return this.enqueue(async function () {
      await self.ready;
      var clock = Number.isFinite(now) ? now : Date.now();
      return self.tx(async function () {
        var row = self.first("SELECT fails, locked_until FROM demo_lock WHERE id = ?", "lock");
        var fails = row ? Number(row.fails) : 0;
        var until = row ? Number(row.locked_until) : 0;
        var locked = until > clock;
        if (action === "clear") {
          self.sql().exec("DELETE FROM demo_lock WHERE id = ?", "lock");
          return { locked: false, fails: 0 };
        }
        if (action === "fail") {
          if (!locked) {
            fails += 1;
            if (fails >= 5) until = clock + 15 * 60 * 1000;
            if (!row) self.sql().exec("INSERT INTO demo_lock (id, fails, locked_until) VALUES ('lock', ?, ?)", fails, until);
            else self.sql().exec("UPDATE demo_lock SET fails = ?, locked_until = ? WHERE id = ?", fails, until, "lock");
            locked = fails >= 5;
          }
          return { locked: locked, fails: fails };
        }
        return { locked: locked, fails: fails };
      });
    });
  }

  async revokeDevice(eh, did) {
    var self = this;
    return this.enqueue(async function () {
      await self.ready;
      try {
        return await self.tx(async function () {
          if (!HEX.test(String(eh || "")) || !SID.test(String(did || ""))) return { ok: false, error: "eh" };
          var row = self.requireEh(eh);
          if (!row || row.eh !== eh) return { ok: false, error: "eh" };
          var account = self.readBody(row);
          var found = false;
          account.devices = (account.devices || []).map(function (device) {
            if (!device || device.id !== did) return device;
            found = true;
            device.revoked = true;
            device.accessSid = "";
            device.cookieSid = "";
            return device;
          });
          var removed = self.sql().exec("DELETE FROM sessions WHERE eh = ? AND did = ?", eh, did);
          if (!found && !(removed && removed.rowsWritten)) return { ok: false, error: "missing" };
          self.sql().exec("INSERT OR IGNORE INTO revoked_devices (did, eh) VALUES (?, ?)", did, eh);
          self.writeBody(eh, account);
          return { ok: true, eh: eh, did: did };
        });
      } catch (err) {
        if (err && err.code) return { ok: false, error: err.code };
        throw err;
      }
    });
  }

  async putCode(input) {
    var self = this;
    return this.enqueue(async function () {
      await self.ready;
      try {
        return await self.tx(async function () {
          return self.insertCode(input);
        });
      } catch (err) {
        if (err && (err.code === "constraint" || /UNIQUE/i.test(String(err.message || "")))) return false;
        if (err && err.code) return { ok: false, error: err.code };
        throw err;
      }
    });
  }

  insertCode(input) {
    if (typeof input === "string") {
      var id = String(input || "");
      if (!id || id.length > 128) throw coded("nonce");
      var existing = this.first("SELECT id FROM nonces WHERE id = ?", id);
      if (existing) return false;
      this.sql().exec("INSERT INTO nonces (id, exp, used) VALUES (?, ?, 0)", id, Date.now() + 10 * 60 * 1000);
      return true;
    }
    var spec = input || {};
    var eh = String(spec.eh || "");
    if (!HEX.test(eh)) throw coded("eh");
    var row = this.first("SELECT eh FROM account");
    if (row && row.eh !== eh) throw coded("eh");
    if (!row) this.writeBody(eh, blankAccount());
    if (spec.uid) this.bindUid(eh, spec.uid, "google");
    var exp = Number(spec.exp);
    if (!spec.hash || !spec.salt || !Number.isFinite(exp) || exp < Date.now()) throw coded("code");
    this.sql().exec("DELETE FROM login_code WHERE eh = ?", eh);
    this.sql().exec(
      "INSERT INTO login_code (eh, hash, salt, attempts, exp, google_verified, uid, hint) VALUES (?, ?, ?, 0, ?, ?, ?, ?)",
      eh,
      String(spec.hash),
      String(spec.salt),
      exp,
      spec.googleVerified === true ? 1 : 0,
      String(spec.uid || ""),
      String(spec.hint || "")
    );
    return { ok: true };
  }

  async consumeCode(input) {
    var self = this;
    return this.enqueue(async function () {
      await self.ready;
      try {
        return await self.tx(async function () {
          return await self.takeCode(input, Date.now());
        });
      } catch (err) {
        if (err && err.code === "eh") return false;
        if (err && err.code) return { ok: false, error: err.code };
        throw err;
      }
    });
  }

  async takeCode(input, now) {
    if (typeof input === "string") {
      var id = String(input || "");
      var nonce = this.first("SELECT id, exp, used FROM nonces WHERE id = ?", id);
      if (!nonce || Number(nonce.used) === 1 || Number(nonce.exp) < now) return false;
      var marked = this.sql().exec("UPDATE nonces SET used = 1 WHERE id = ? AND used = 0", id);
      return Boolean(marked && marked.rowsWritten);
    }
    var spec = input || {};
    var eh = String(spec.eh || "");
    var row = this.requireEh(eh);
    if (!row || row.eh !== eh) return { ok: false, error: "eh" };
    if (spec.drop === true) {
      this.sql().exec("DELETE FROM login_code WHERE eh = ?", eh);
      return { ok: true, dropped: true };
    }
    var code = this.first("SELECT eh, hash, salt, attempts, exp, google_verified, uid, hint FROM login_code WHERE eh = ?", eh);
    if (!code) return { ok: false, error: "missing" };
    if (code.eh !== eh) return { ok: false, error: "eh" };
    if (Number(code.exp) < now) return { ok: false, error: "expired" };
    if (Number(code.attempts) >= 5) return { ok: false, error: "locked" };
    var email = String(spec.email || "").toLowerCase().trim();
    var emailHash = await sha256Hex(email);
    if (emailHash !== eh) return { ok: false, error: "eh" };
    var presented = await sha256Hex(String(spec.presented || "") + ":" + code.salt + ":" + email);
    var attempts = Number(code.attempts) + 1;
    if (!safeEqual(presented, code.hash)) {
      if (attempts >= 5) this.sql().exec("DELETE FROM login_code WHERE eh = ?", eh);
      else this.sql().exec("UPDATE login_code SET attempts = ? WHERE eh = ?", attempts, eh);
      return { ok: false, error: attempts >= 5 ? "locked" : "code" };
    }
    this.sql().exec("DELETE FROM login_code WHERE eh = ?", eh);
    return {
      ok: true,
      eh: code.eh,
      googleVerified: code.google_verified === 1,
      uid: String(code.uid || ""),
      hint: String(code.hint || "")
    };
  }

  async bindHuman(id, scope) {
    var self = this;
    return this.enqueue(async function () {
      await self.ready;
      try {
        return await self.tx(async function () {
          var box = scope || {};
          var eh = String(box.eh || "");
          self.requireEh(eh);
          if (!self.accountRow()) self.writeBody(eh, blankAccount());
          self.bindUid(eh, id, box.provider);
          return true;
        });
      } catch (err) {
        if (err && err.code) return false;
        throw err;
      }
    });
  }
}
