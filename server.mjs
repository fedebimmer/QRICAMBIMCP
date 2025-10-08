import express from "express";

const app = express();
app.use(express.json({ limit: "1mb" }));

// --- CORS globale + preflight ---
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// --- helper ---
const sendSSE = (res, id, payload) =>
  res.write(`event: message\nid: ${id}\ndata: ${JSON.stringify(payload)}\n\n`);

const bearer = () => {
  const t = process.env.QRICAMBI_BEARER;
  if (!t) throw new Error("QRICAMBI_BEARER mancante");
  return `Bearer ${t}`;
};

const openSSE = (res) => {
  res.status(200);
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Authorization"
  });
  // Heartbeat per evitare timeout (15s)
  const hb = setInterval(() => res.write(`: ping\n\n`), 15000);
  res.on("close", () => clearInterval(hb));
};

const sendTools = (res) => {
  sendSSE(res, "tools", {
    jsonrpc: "2.0",
    method: "tools/list",
    result: {
      tools: [
        {
          name: "qricambi.mysupplier",
          description: "Elenco fornitori salvati",
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

// --- health check ---
app.get("/", (_req, res) => res.send("Qricambi MCP up"));

// --- preflight explicito per /sse ---
app.options("/sse", (_req, res) => res.sendStatus(204));

// --- handshake GET /sse ---
app.get("/sse", (req, res) => {
  openSSE(res);
  sendTools(res);
});

// --- POST /sse: flusso + invocazioni tools ---
app.post("/sse", (req, res) => {
  openSSE(res);
  sendTools(res);

  req.on("data", async (buf) => {
    for (const line of buf.toString().trim().split(/\n/).filter(Boolean)) {
      try {
        const msg = JSON.parse(line);
        if (msg.method !== "tools/call") continue;

        const { name, arguments: args } = msg.params || {};
        let out;

        if (name === "qricambi.mysupplier") {
          const r = await fetch("https://api.qricambi.com/mysupplier", {
            headers: { Authorization: bearer(), accept: "application/json" }
          });
          out = await r.json();
        }

        else if (name === "qricambi.searchPriceAvailability") {
          if (!args?.skus || !Array.isArray(args.skus) || args.skus.length === 0 || args.skus.length > 3) {
            sendSSE(res, msg.id, { jsonrpc: "2.0", error: { code: -32000, message: "1–3 SKU richiesti" } });
            continue;
          }
          const r = await fetch("https://api.qricambi.com/searchpriceandavailability", {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: bearer() },
            body: JSON.stringify({
              supplier: args.supplier,
              skus: args.skus,
              qty: args.qty ?? 1,
              brand_input: args.brand_input,
              user: args.user,
              password: args.password
            })
          });
          out = await r.json();
        }

        else if (name === "qricambi.vehicleByPlate") {
          const u = new URL("https://api.qricambi.com/vehiclebyplate");
          u.searchParams.set("plate", args.plate);
          const r = await fetch(u, {
            headers: { Authorization: bearer(), accept: "application/json" }
          });
          out = await r.json();
        }

        else {
          sendSSE(res, msg.id, { jsonrpc: "2.0", error: { code: -32601, message: "Tool sconosciuto" } });
          continue;
        }

        sendSSE(res, msg.id, { jsonrpc: "2.0", result: out });
      } catch (e) {
        sendSSE(res, "err", {
          jsonrpc: "2.0",
          error: { code: -32000, message: String(e.message || e) }
        });
      }
    }
  });

  req.on("close", () => res.end());
});

// --- avvio ---
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`MCP on :${PORT}`));
