// Netlify Function serving every /api/* route. The logic lives in server/handler.js.
import { createHandler } from "../../server/handler.js";
import { blobStore } from "../../server/blobStore.js";

export default async (req) => {
  const handle = createHandler({ store: blobStore(), password: process.env.APP_PASSWORD });
  return handle(req);
};

export const config = { path: "/api/*" };
