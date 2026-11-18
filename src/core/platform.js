const isNode =
  typeof process !== 'undefined' &&
  !!process.versions?.node &&
  typeof window === 'undefined';

export function runningInNode() { return isNode; }

export async function loadHarfBuzzModule() {
  if (isNode) {
    // Node-only specifiers are resolved through a computed name so the browser
    // bundle never tries to externalize them.
    const nodeUrl = `node:${'url'}`;
    const { pathToFileURL } = await import(/* @vite-ignore */ nodeUrl);
    const url = new URL('../../public/vendor/harfbuzz/index.mjs', import.meta.url);
    return import(pathToFileURL(url.pathname).href);
  }
  // Served from public/ untouched by the bundler.
  const url = new URL('/vendor/harfbuzz/index.mjs', window.location.href).href;
  return import(/* @vite-ignore */ url);
}

export async function fetchFontBytes(url) {
  if (isNode) {
    const nodeFs = `node:${'fs/promises'}`;
    const { readFile } = await import(/* @vite-ignore */ nodeFs);
    const path = new URL(`../../public${url}`, import.meta.url);
    const buf = await readFile(path);
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Font fetch failed (${res.status}) for ${url}`);
  return new Uint8Array(await res.arrayBuffer());
}
