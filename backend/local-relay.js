process.env.VALHALLA_LOCAL_RELAY = "1";
process.env.OLLAMA_URL = process.env.OLLAMA_URL || "http://127.0.0.1:11434";
await import("./valhallaMasterEngineV35.js");
