#!/usr/bin/env node
// Sonda descartable: handshake Gateway Protocol v4 + health + agents.list
// Uso: node openclaw-handshake-probe.mjs
// Requiere: node >= 20 (WebSocket global) — sin dependencias npm.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import crypto from "node:crypto";

const GW_URL = "ws://127.0.0.1:18789";

// 1) Token desde la config (no hardcodear)
const cfg = JSON.parse(readFileSync(join(homedir(), ".openclaw/openclaw.json"), "utf8"));
const TOKEN = cfg?.gateway?.auth?.token ?? cfg?.gateway?.auth?.password;
if (!TOKEN) throw new Error("No gateway token/password found in ~/.openclaw/openclaw.json");

// 2) Identidad de dispositivo (efímera para la sonda; el PWA la persistirá)
const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
const jwk = publicKey.export({ format: "jwk" }); // jwk.x = raw public key en base64url
const publicKeyRawB64Url = jwk.x;
const deviceId = crypto.createHash("sha256").update(Buffer.from(publicKeyRawB64Url, "base64url")).digest("hex");

const CLIENT = { id: "openclaw-probe", version: "0.0.1", platform: "linux", mode: "probe" };
const ROLE = "operator";
const SCOPES = ["operator.read", "operator.write"];

function sign(payload) {
  return crypto.sign(null, Buffer.from(payload, "utf8"), privateKey).toString("base64url");
}

// 3) Cliente WS mínimo con req/res
let seq = 0;
const pending = new Map();
let ws;

function send(method, params = {}) {
  const id = `req-${++seq}-${Date.now()}`;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ type: "req", id, method, params }));
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`timeout: ${method}`));
      }
    }, 15000);
  });
}

ws = new WebSocket(GW_URL);

ws.onmessage = async (ev) => {
  const frame = JSON.parse(ev.data);

  if (frame.type === "event" && frame.event === "connect.challenge") {
    const { nonce, ts } = frame.payload;
    const signedAtMs = ts ?? Date.now();

    const payload = [
      "v3", deviceId, CLIENT.id, CLIENT.mode, ROLE, SCOPES.join(","),
      String(signedAtMs), TOKEN, nonce, CLIENT.platform, "",
    ].join("|");

    const hello = await send("connect", {
      minProtocol: 4,
      maxProtocol: 4,
      client: CLIENT,
      role: ROLE,
      scopes: SCOPES,
      caps: [],
      commands: [],
      permissions: {},
      auth: { token: TOKEN },
      locale: "es-UY",
      userAgent: "hue-probe/0.0.1",
      device: {
        id: deviceId,
        publicKey: publicKeyRawB64Url,
        signature: sign(payload),
        signedAt: signedAtMs,
        nonce,
      },
    });
    console.log("✅ hello-ok:");
    console.log("   protocol:", hello.protocol, "| server:", hello.server?.version);
    console.log("   role:", hello.auth?.role, "| scopes:", hello.auth?.scopes);
    console.log("   deviceToken emitido:", Boolean(hello.auth?.deviceToken));
    console.log("   métodos disponibles:", hello.features?.methods?.length ?? "?");

    // 4) Pruebas
    const health = await send("health");
    console.log("✅ health:", JSON.stringify(health).slice(0, 200));

    const agents = await send("agents.list");
    const list = Array.isArray(agents) ? agents : agents?.agents ?? [];
    console.log("✅ agents.list:", list.map((a) => a.id).join(", ") || "(vacío)");

    ws.close();
    process.exit(0);
  }

  if (frame.type === "res") {
    const p = pending.get(frame.id);
    if (!p) return;
    pending.delete(frame.id);
    if (frame.ok) p.resolve(frame.payload);
    else p.reject(new Error(`${frame.error?.code ?? "ERROR"}: ${frame.error?.message ?? JSON.stringify(frame.error)}`));
  }
};

ws.onerror = (e) => { console.error("❌ ws error:", e.message ?? e); process.exit(1); };
ws.onclose = (e) => {
  if (e.code !== 1000 && e.code !== 1005) {
    console.error("❌ cerrado:", e.code, e.reason);
    process.exit(1);
  }
};
