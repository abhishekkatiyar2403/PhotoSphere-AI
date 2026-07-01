import dotenv from "dotenv";
import path from "node:path";

// Load the repo-root .env (one level up from /backend) so a single .env
// file covers both frontend and backend, per the scaffolding spec.
dotenv.config({ path: path.resolve(__dirname, "../../.env") });

import { createApp } from "./app";

const PORT = Number(process.env.PORT ?? 4000);

const app = createApp();

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`[backend] listening on http://localhost:${PORT}`);
});
