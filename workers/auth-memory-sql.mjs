import { DatabaseSync } from "node:sqlite";

export function memoryCtx() {
  var db = new DatabaseSync(":memory:");
  function empty(written) {
    return {
      toArray: function () { return []; },
      one: function () { return null; },
      rowsWritten: written || 0
    };
  }
  return {
    storage: {
      sql: {
        exec: function (query, ...params) {
          var text = String(query || "").trim();
          if (!params.length && /^(create|drop|begin|commit|rollback)/i.test(text)) {
            db.exec(text);
            return empty(0);
          }
          var stmt = db.prepare(text);
          if (/^select/i.test(text)) {
            var list = stmt.all(...params);
            return {
              toArray: function () { return list; },
              one: function () {
                if (list.length !== 1) {
                  var err = new Error("one() requires exactly one row");
                  err.code = "sqlite-one";
                  throw err;
                }
                return list[0];
              },
              rowsWritten: 0
            };
          }
          var info = stmt.run(...params);
          return empty(Number(info.changes || 0));
        }
      },
      transaction: async function (fn) {
        db.exec("BEGIN");
        try {
          var out = await fn();
          db.exec("COMMIT");
          return out;
        } catch (err) {
          db.exec("ROLLBACK");
          throw err;
        }
      }
    },
    blockConcurrencyWhile: function (fn) { return Promise.resolve().then(fn); }
  };
}

export function namespace(AuthDurableObject) {
  var objects = new Map();
  return {
    idFromName: function (name) {
      return { name: String(name), toString: function () { return "id:" + name; } };
    },
    get: function (id) {
      var key = id && id.name;
      if (!key) throw new Error("missing-id");
      if (!objects.has(key)) objects.set(key, new AuthDurableObject(memoryCtx()));
      return objects.get(key);
    },
    putSession: function () { throw new Error("namespace-method"); },
    readSession: function () { throw new Error("namespace-method"); },
    revokeDevice: function () { throw new Error("namespace-method"); },
    putCode: function () { throw new Error("namespace-method"); },
    consumeCode: function () { throw new Error("namespace-method"); },
    bindHuman: function () { throw new Error("namespace-method"); },
    objects: objects
  };
}
