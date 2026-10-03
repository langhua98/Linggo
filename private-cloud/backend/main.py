"""API 进程入口：uvicorn backend.main:app

前端（Next.js 静态导出到 frontend/out）也由这里一起提供，部署只要一个端口。"""
import asyncio
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.exceptions import HTTPException as FastAPIHTTPException
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy import func, select
from starlette.exceptions import HTTPException as StarletteHTTPException

from .api import admin, auth, files, folders, search, upload
from .config import get_settings
from .database import init_db, session_scope
from .models import User
from .security import hash_password
from .services import log_service
from .services.storage_service import set_storage
from .services.telegram_service import create_storage

log = logging.getLogger('cloud')


def ensure_admin():
    """第一次启动：用 ADMIN_USERNAME / ADMIN_PASSWORD 建管理员。已经有用户就什么都不做。"""
    s = get_settings()
    with session_scope() as db:
        if db.scalar(select(func.count(User.id))):
            return
        if not (s.admin_username and s.admin_password):
            log.warning('还没有任何用户：设置 ADMIN_USERNAME / ADMIN_PASSWORD 后重启，或运行 python -m backend.cli create-user')
            return
        db.add(User(username=s.admin_username, password_hash=hash_password(s.admin_password), is_admin=True))
    log_service.record('admin_created', s.admin_username, source='api')


async def connect_storage(app):
    s = get_settings()
    storage = create_storage(s, role='api')
    for attempt in range(1, 6):
        try:
            await storage.start()
            set_storage(storage)
            app.state.storage = storage
            return
        except Exception as e:  # noqa: BLE001
            log_service.record('storage_connect_failed', f'第 {attempt} 次：{e}', level='error')
            # 配置缺失重试也没用
            if 'TELEGRAM_' in str(e):
                return
            await asyncio.sleep(min(60, 5 * attempt))


@asynccontextmanager
async def lifespan(app):
    logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(name)s %(message)s')
    init_db()
    ensure_admin()
    app.state.storage = None
    # 不等 Telegram 连上就开始服务：连不上时文件列表、上传照常可用，只有下载 / 播放 / 永久删除会提示
    task = asyncio.create_task(connect_storage(app))
    try:
        yield
    finally:
        task.cancel()
        if app.state.storage:
            await app.state.storage.stop()


app = FastAPI(title='Telegram Private Cloud Drive', lifespan=lifespan, docs_url='/api/docs', redoc_url=None,
              openapi_url='/api/openapi.json')

for r in (auth, files, folders, upload, search, admin):
    app.include_router(r.router)


@app.exception_handler(StarletteHTTPException)
async def http_error(request: Request, exc: StarletteHTTPException):
    detail = exc.detail
    body = detail if isinstance(detail, dict) else {'message': detail}
    body.setdefault('message', '出错了')
    return JSONResponse(body, status_code=exc.status_code, headers=getattr(exc, 'headers', None))


@app.exception_handler(RequestValidationError)
async def validation_error(request: Request, exc: RequestValidationError):
    first = exc.errors()[0] if exc.errors() else {}
    field = '.'.join(str(x) for x in first.get('loc', [])[1:])
    return JSONResponse({'message': f'参数不对：{field} {first.get("msg", "")}'.strip(), 'errors': exc.errors()},
                        status_code=422)


@app.middleware('http')
async def security_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers.setdefault('X-Content-Type-Options', 'nosniff')
    response.headers.setdefault('Referrer-Policy', 'same-origin')
    response.headers.setdefault('X-Frame-Options', 'SAMEORIGIN')
    if request.url.path.startswith('/api/') and 'cache-control' not in response.headers:
        response.headers['Cache-Control'] = 'no-store'
    return response


@app.get('/api/health')
def health():
    return {'ok': True}


_front = get_settings().frontend_dir
if _front and _front.is_dir():
    class SPAStatic(StaticFiles):
        """静态导出的页面：/files → files/index.html；找不到的页面回到首页。"""

        async def get_response(self, path, scope):
            try:
                return await super().get_response(path, scope)
            except (StarletteHTTPException, FastAPIHTTPException) as e:
                if e.status_code != 404 or path.startswith('api/'):
                    raise
                return await super().get_response('index.html', scope)

    app.mount('/', SPAStatic(directory=str(_front), html=True), name='frontend')
