// 页面之间的小广播：文件夹变了 → 侧边栏目录树刷新
type Fn = () => void;
const subs = new Map<string, Set<Fn>>();

export function on(event: string, fn: Fn) {
  if (!subs.has(event)) subs.set(event, new Set());
  subs.get(event)!.add(fn);
  return () => {
    subs.get(event)!.delete(fn);
  };
}

export function emit(event: string) {
  subs.get(event)?.forEach((f) => f());
}
