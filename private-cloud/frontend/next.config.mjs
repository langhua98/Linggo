// 生产：静态导出到 out/，由 FastAPI 一起提供（同一个域名，登录 Cookie 直接可用）
// 开发：next dev，把 /api 转发给本地后端
const isDev = process.env.NODE_ENV === 'development';
const backend = process.env.BACKEND_URL || 'http://127.0.0.1:8000';

/** @type {import('next').NextConfig} */
const config = isDev
  ? {
      async rewrites() {
        return [{ source: '/api/:path*', destination: `${backend}/api/:path*` }];
      },
    }
  : { output: 'export', trailingSlash: true, images: { unoptimized: true } };

export default config;
