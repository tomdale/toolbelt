// Newer Node versions define a global `localStorage` that shadows jsdom's and
// lacks a backing file under Vitest. Replace it with an in-memory Storage so
// components that persist UI state behave as they do in the browser.
class MemoryStorage implements Storage {
  private items = new Map<string, string>();
  get length() {
    return this.items.size;
  }
  clear() {
    this.items.clear();
  }
  getItem(key: string) {
    return this.items.get(key) ?? null;
  }
  key(index: number) {
    return [...this.items.keys()][index] ?? null;
  }
  removeItem(key: string) {
    this.items.delete(key);
  }
  setItem(key: string, value: string) {
    this.items.set(key, String(value));
  }
}

if (typeof globalThis.localStorage?.clear !== "function") {
  const storage = new MemoryStorage();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: storage,
  });
  if (typeof window !== "undefined")
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: storage,
    });
}
