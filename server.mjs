import express from "express";
import http from "http";

const app = express();
app.disable("etag");
app.set("x-powered-by", false);
app.use(express.json({ limit: "1mb" }));

// CORS + preflight
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS,HEAD");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
  if (req.method === "OPTIONS" || req.method === "HEAD") return res.sendStatus(204);
  next();
});

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
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS,HEAD",
    "Access-Control-Allow-Headers": "Content-Type,Authorization"
  });
  // padding + retry + flush immediato
  res.write(":" + " ".repeat(2048) + "\n\n");
  res.write("retry: 4000\n\n");
  if (typeof res.flushHeaders === "function") res.flushHeaders();
  const hb = setInterval(() => res.write(`: ping\n\n`), 8000);
  res.on("close", () => clearInterval(hb));
};

const sendTools = (res) => {
  sendSSE(res, "tools", {
    jsonrpc: "2.0",
    method: "tools/list",
    result: {
      tools: [
        { name: "search",
          description: "plate:AB123CD oppure supplier:NOME skus:SKU1,SKU2,SKU3",
          input_schema: { type: "object", required: ["query"], properties: { query: { type: "string" } } } },
        { name: "fetch",
          description: "Dettaglio per id di search",
          input_schema: { type: "object", required: ["id"], properties: { id: { type: "string" } } } },
        { name: "qricambi.mysupplier", description: "Elenco fornitori", input_schema: { type: "object", properties: {} } },
        { name: "qricambi.searchPriceAvailability",
          description: "Prezzi/disponibilità (max 3 SKU)",
          input_schema: { type: "object", required: ["supplier","skus"],
            properties: { supplier:{type:"string"}, skus:{type:"array",maxItems:3,items:{type:"string"}}, qty:{type:"integer",minimum:1}, brand_input:{type:"string"}, user:{type:"string"}, password:{type:"string"} } } },
        { name: "qricambi.vehicleByPlate",
          description: "Dati veicolo da targa IT",
          input_schema: { type:"object", required:["plate"], properties:{ plate:{type:"string"} } } }
      ]
    }
  });
};

app.get("/", (_req, res) => res.send("Qricambi MCP up"));
app.options("/sse", (_req, res) => res.sendStatus(204));
app.head("/sse", (_req, res) => res.sendStatus(204));

app.get("/sse", (req, res) => {
  openSSE(res);
  sendTools(res);
  setTimeout(() => sendTools(res), 700);
});

app.post("/sse", (req, res) => {
  openSSE(res);
  sendTools(res);
  req.on("data", async (buf) => {
    for (const line of buf.toString().trim().split(/\n/).filter(Boolean)) {
      try {
        const msg = JSON.parse(line);
        if (msg.method !== "tools/call") continue;
        const { name, arguments: args } = msg.params || {};

        if (name === "search") {
          const plate = args?.query?.match(/plate:([A-Z0-9]+)/i)?.[1]?.toUpperCase();
          const supplier = args?.query?.match(/supplier:([^\s]+)/i)?.[1];
          const skus = args?.query?.match(/skus:([A-Za-z0-9,\-_.]+)/i)?.[1];
          const results = [];
          if (plate) results.push({ id:`plate|${plate}`, title:`Veicolo ${plate}`, url:`vehiclebyplate:${plate}` });
          if (supplier && skus) skus.split(",").map(s=>s.trim()).filter(Boolean).slice(0,3)
            .forEach(sku => results.push({ id:`price|${supplier}|${sku}`, title:`Prezzo ${sku} @ ${supplier}`, url:`searchpriceandavailability:${supplier}:${sku}` }));
          sendSSE(res, msg.id, { jsonrpc:"2.0", content: contentText(results.length?{results}:{error:"Query non supportata"}) });
          continue;
        }

        if (name === "fetch") {
          const id = String(args?.id || "");
          if (id.startsWith("plate|")) {
            const plate = id.split("|")[1];
            const u = new URL("https://api.qricambi.com/vehiclebyplate"); u.searchParams.set("plate", plate);
            const r = await fetch(u, { headers:{ Authorization: bearer(), accept:"application/json" } });
            const data = await r.json();
            sendSSE(res, msg.id, { jsonrpc:"2.0", content: contentText({ id, title:`Veicolo ${plate}`, text: JSON.stringify(data), url:`vehiclebyplate:${plate}` }) });
            continue;
          }
          if (id.startsWith("price|")) {
            const [, supplier, sku] = id.split("|");
            const r = await fetch("https://api.qricambi.com/searchpriceandavailability", {
              method:"POST", headers:{ "Content-Type":"application/json", Authorization: bearer() },
              body: JSON.stringify({ supplier, skus:[sku], qty:1 })
            });
            const data = await r.json();
            sendSSE(res, msg.id, { jsonrpc:"2.0", content: contentText({ id, title:`Prezzo ${sku} @ ${supplier}`, text: JSON.stringify(data), url:`searchpriceandavailability:${supplier}:${sku}` }) });
            continue;
          }
          sendSSE(res, msg.id, { jsonrpc:"2.0", content: contentText({ error:"id non riconosciuto" }) });
          continue;
        }

        if (name === "qricambi.mysupplier") {
          const r = await fetch("https://api.qricambi.com/mysupplier", { headers:{ Authorization: bearer(), accept:"application/json" } });
          sendSSE(res, msg.id, { jsonrpc:"2.0", content: contentText(await r.json()) });
          continue;
        }

        if (name === "qricambi.searchPriceAvailability") {
          const a = args || {};
          if (!a?.skus || !Array.isArray(a.skus) || a.skus.length === 0 || a.skus.length > 3) {
            sendSSE(res, msg.id, { jsonrpc:"2.0", content: contentText({ error:"1–3 SKU richiesti" }) });
            continue;
          }
          const r = await fetch("https://api.qricambi.com/searchpriceandavailability", {
            method:"POST", headers:{ "Content-Type":"application/json", Authorization: bearer() },
            body: JSON.stringify({ supplier:a.supplier, skus:a.skus, qty:a.qty ?? 1, brand_input:a.brand_input, user:a.user, password:a.password })
          });
          sendSSE(res, msg.id, { jsonrpc:"2.0", content: contentText(await r.json()) });
          continue;
        }

        if (name === "qricambi.vehicleByPlate") {
          const u = new URL("https://api.qricambi.com/vehiclebyplate"); u.searchParams.set("plate", args?.plate);
          const r = await fetch(u, { headers:{ Authorization: bearer(), accept:"application/json" } });
          sendSSE(res, msg.id, { jsonrpc:"2.0", content: contentText(await r.json()) });
          continue;
        }

        sendSSE(res, msg.id, { jsonrpc:"2.0", content: contentText({ error:"Tool sconosciuto" }) });
      } catch (e) {
        sendSSE(res, "err", { jsonrpc:"2.0", content: contentText({ error:String(e.message || e) }) });
      }
    }
  });
  req.on("close", () => res.end());
});

// avvio con timeouts estesi
const server = http.createServer(app);
server.keepAliveTimeout = 75_000;
server.headersTimeout = 80_000;
server.requestTimeout = 0;
const PORT = process.env.PORT || 8080;
server.listen(PORT, () => console.log(`MCP on :${PORT}`));
