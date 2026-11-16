/** Short random ids; works in Node and the browser (Web Crypto). */
export const newId = (prefix: string) => `${prefix}_${globalThis.crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
