import express from "express";

export const app = express();

app.get("/health", (_req, res) => {
  res.json({ status: "ok", uptime: process.uptime() });
});
