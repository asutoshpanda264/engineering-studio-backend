import express from "express";
import { verify } from "./verify.js";

const app = express();
app.use(express.json({ limit: "2mb" }));

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.post("/verify", (req, res) => {
  const { scenario, graph } = req.body ?? {};
  if (!scenario || !graph || !Array.isArray(graph.nodes) || !Array.isArray(graph.connections)) {
    res.status(400).json({ error: "Request must include `scenario` and `graph: {nodes, connections}`" });
    return;
  }

  try {
    const outcome = verify({ scenario, graph });
    res.json(outcome);
  } catch (err) {
    // Anything here (a malformed scenario body, an unsupported entity type,
    // an internal engine error) is the caller's problem to know about, not
    // something to swallow into a fake success — the whole point of this
    // service is being a trustworthy source of truth for scores.
    console.error("verify failed:", err);
    res.status(500).json({ error: err instanceof Error ? err.message : "Verification failed" });
  }
});

const port = Number(process.env.PORT ?? 4000);
app.listen(port, () => {
  console.log(`engineering-studio-verify listening on :${port}`);
});
