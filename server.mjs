import express from "express";

const app = express();
app.disable("etag");
app.set("x-powered-by", false);
app.use(express.json({ limit: "1mb" }));

// -------- CORS + preflight --------
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// -------- helper --------
const sendSSE = (res, id, payload) =>
  res.write(`event: message\nid: ${id}\ndata: ${JSON.stringify(payload)}\n\n`);
const contentText = (obj) => [{ type: "text", text: JSON.stringify(obj) }];

const bearer = () => {
  const t = process.env.QRICAMBI_BEARER;
  if (!t) throw new Error("QRICAMBI_BEARER mancante");
  return `Bearer ${t}`;
};

const openSSE = (res) => {
  res.status(200);
  res.set({
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Authorization"
  });
  // padding iniziale + retry
  res.write(":" + " ".repeat(2048) + "\n\n");
  res.write("retry: 4000\n\n");
  // flush immediato degli header
  if (typeof res.flushHeaders === "function") res.flushHeaders();
  // heartbeat 8s
  const hb = setInterval(() => res.write(`: ping\n\n`), 8000);
  res.on("close", () => clearInterval(hb));
};

const sendTools = (res) => {
  sendSSE(res, "tools", {
    jsonrpc: "2.0",
    method: "tools/list",
    result: {
      tools: [
        // Standard MCP
        {
          name: "search",
          description:
            "Ricerca Qricambi. Formati: 'plate:AB123CD' o 'supplier:NOME skus:SKU1,SKU2,SKU3'.",
          input_schema: {
            type: "object",
            required: ["query"],
            properties: { query: { type: "string" } }
          }
        },
        {
          name: "fetch",
          description: "Dettaglio per un id restituito da search.",
          input_schema: {
            type: "object",
            required: ["id"],
            properties: { id: { type: "string" } }
          }
        },
        // Tool specifici
        {
          name: "qricambi.mysupplier",
          description: "Elenco fornitori salvati nel tuo account Qricambi",
          input_schema: { type: "object", properties: {} }
        },
        {
          name: "qricambi.searchPriceAvailability",
          description: "Prezzi netti e disponibilità per un fornitore",
          input_schema: {
            type: "object",
            required: ["supplier", "skus"],
            properties: {
              supplier: { type: "string" },
              skus: { type: "array", maxItems: 3, items: { type: "string" } },
              qty: { type: "integer", minimum: 1 },
              brand_input: { type: "string" },
              user: { type: "string" },
              password: { type: "string" }
            }
          }
        },
        {
          name: "qricambi.vehicleByPlate",
          description: "Dati veicolo da targa IT",
          input_schema: {
            type: "object",
            required: ["plate"],
            properties: { plate: { type: "string" } }
          }
        }
      ]
    }
  });
};

// -------- health --------
app.get("/", (_req, res) => res.send("Qricambi MCP up"));
app.get("/healthz", (_req, res) => res.status(200).json({ ok: true }));

// Preflight esplicito
app.options("/sse", (_req, res) => res.sendStatus(204));

// -------- GET /sse --------
app.get("/sse", (req, res) => {
  openSSE(res);
  sendTools(res);
  setTimeout(() => sendTools(res), 700); // secondo invio per client lenti
});

// -------- POST /sse --------
app.post("/sse", (req, res) => {
  openSSE(res);
  sendTools(res);

  req.on("data", async (buf) => {
    for (const line of buf.toString().trim().split(/\n/).filter(Boolean)) {
      try {
        const msg = JSON.parse(line);
        if (msg.method !== "tools/call") continue;
        const { name, arguments: args } = msg.params || {};

        // ---- ROUTER ----
        if (name === "search") {
          const plateMatch = args?.query?.match(/plate:([A-Z0-9]+)/i);
          const supplierMatch = args?.query?.match(/supplier:([^\s]+)/i);
          const skusMatch = args?.query?.match(/skus:([A-Za-z0-9,\-_.]+)/i);
          const results = [];

          if (plateMatch) {
            const plate = plateMatch[1].toUpperCase();
            results.push({ id: `plate|${plate}`, title: `Veicolo ${plate}`, url: `vehiclebyplate:${plate}` });
          }
          if (supplierMatch && skusMatch) {
            const supplier = supplierMatch[1];
            const skus = skusMatch[1].split(",").map(s => s.trim()).filter(Boolean).slice(0,3);
            for (const sku of skus) results.push({ id: `price|${supplier}|${sku}`, title: `Prezzo ${sku} @ ${supplier}`, url: `searchpriceandavailability:${supplier}:${sku}` });
          }
          if (!results.length) {
            sendSSE(res, msg.id, { jsonrpc: "2.0", content: contentText({ error: "Query non supportata" }) });
          } else {
            sendSSE(res, msg.id, { jsonrpc: "2.0", content: contentText({ results }) });
          }
          continue;
        }

        if (name === "fetch") {
          const id = String(args?.id || "");
          if (id.startsWith("plate|")) {
            const plate = id.split("|")[1];
            const u = new URL("https://api.qricambi.com/vehiclebyplate");
            u.searchParams.set("plate", plate);
            const r = await fetch(u, { headers: { Authorization: bearer(), accept: "application/json" }});
            const data = await r.json();
            sendSSE(res, msg.id, { jsonrpc: "2.0", content: contentText({ id, title: `Veicolo ${plate}`, text: JSON.stringify(data), url: `vehiclebyplate:${plate}` }) });
            continue;
          }
          if (id.startsWith("price|")) {
            const [, supplier, sku] = id.split("|");
            const r = await fetch("https://api.qricambi.com/searchpriceandavailability", {
              method: "POST",
              headers: { "Content-Type": "application/json", Authorization: bearer() },
              body: JSON.stringify({ supplier, skus: [sku], qty: 1 })
            });
            const data = await r.json();
            sendSSE(res, msg.id, { jsonrpc: "2.0", content: contentText({ id, title: `Prezzo ${sku} @ ${supplier}`, text: JSON.stringify(data), url: `searchpriceandavailability:${supplier}:${sku}` }) });
            continue;
          }
          sendSSE(res, msg.id, { jsonrpc: "2.0", content: contentText({ error: "id non riconosciuto" }) });
          continue;
        }

        if (name === "qricambi.mysupplier") {
          const r = await fetch("https://api.qricambi.com/mysupplier", { headers: { Authorization: bearer(), accept: "application/json" } });
          sendSSE(res, msg.id, { jsonrpc: "2.0", content: contentText(await r.json()) });
          continue;
        }

        if (name === "qricambi.searchPriceAvailability") {
          const a = args || {};
          if (!a?.skus || !Array.isArray(a.skus) || a.skus.length === 0 || a.skus.length > 3) {
            sendSSE(res, msg.id, { jsonrpc: "2.0", content: contentText({ error: "1–3 SKU richiesti" }) });
            continue;
          }
          const r = await fetch("https://api.qricambi.com/searchpriceandavailability", {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: bearer() },
            body: JSON.stringify({ supplier: a.supplier, skus: a.skus, qty: a.qty ?? 1, brand_input: a.brand_input, user: a.user, password: a.password })
          });
          sendSSE(res, msg.id, { jsonrpc: "2.0", content: contentText(await r.json()) });
          continue;
        }

        if (name === "qricambi.vehicleByPlate") {
          const u = new URL("https://api.qricambi.com/vehiclebyplate");
          u.searchParams.set("plate", args?.plate);
          const r = await fetch(u, { headers: { Authorization: bearer(), accept: "application/json" } });
          sendSSE(res, msg.id, { jsonrpc: "2.0", content: contentText(await r.json()) });
          continue;
        }

        sendSSE(res, msg.id, { jsonrpc: "2.0", content: contentText({ error: "Tool sconosciuto" }) });
      } catch (e) {
        sendSSE(res, "err", { jsonrpc: "2.0", content: contentText({ error: String(e.message || e) }) });
      }
    }
  });

  req.on("close", () => res.end());
});

// -------- avvio --------
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`MCP on :${PORT}`));
