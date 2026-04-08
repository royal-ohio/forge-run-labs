// DEV ONLY — NOT USED IN PRODUCTION
// The production /healthz endpoint is served by reality-adapter/adapter.ts
// This file is retained for local development and testing only.

const express = require("express");
const app = express();

app.get("/healthz", (req, res) => {
  res.status(200).json({ status: "ok", timestamp: new Date().toISOString() });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log("Healthz server on port " + PORT);
});
