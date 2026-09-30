// Node 里没有 cloudflare:workers 这个内置模块，测试时换成本地替身
export async function resolve(specifier, context, next) {
  if (specifier === 'cloudflare:workers') {
    return { url: new URL('./cloudflare-workers.mjs', import.meta.url).href, shortCircuit: true };
  }
  return next(specifier, context);
}
