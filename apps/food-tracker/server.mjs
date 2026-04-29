import "dotenv/config";

import { analyzeFoodHandler } from "@tinyapps/appkit/server/analyze-food";
import express from "express";
import { createServer as createViteServer } from "vite";

const app = express();
const port = Number(process.env.PORT || 5173);

app.use(express.json({ limit: "16mb" }));
app.post("/api/analyze-food", analyzeFoodHandler);

const vite = await createViteServer({
  root: new URL(".", import.meta.url).pathname,
  server: { middlewareMode: true },
  appType: "spa",
});
app.use(vite.middlewares);

app.listen(port, "127.0.0.1", () => {
  console.log(`food tracker running at http://127.0.0.1:${port}`);
});
