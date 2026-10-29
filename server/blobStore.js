// Storage adapter on top of Netlify Blobs (a small key-value store built into Netlify).
// Each application is one JSON blob, keyed by its id.

import { getStore } from "@netlify/blobs";

export function blobStore(name = "applications") {
  // "strong" consistency means a list right after a write always includes that write.
  const store = getStore({ name, consistency: "strong" });

  return {
    async list() {
      const { blobs } = await store.list();
      const records = await Promise.all(blobs.map((b) => store.get(b.key, { type: "json" })));
      return records.filter(Boolean);
    },
    get: (id) => store.get(id, { type: "json" }),
    set: (id, value) => store.setJSON(id, value),
    delete: (id) => store.delete(id),
  };
}
