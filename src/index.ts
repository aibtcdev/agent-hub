import { createApp } from "./app.js";
import { createBunClient } from "./db-bun.js";

const db = createBunClient();
const app = createApp(db);

const port = parseInt(process.env.PORT ?? "3100");

console.log(`agent-hub listening on http://localhost:${port}`);

export { app };

export default {
  port,
  fetch: app.fetch,
};
