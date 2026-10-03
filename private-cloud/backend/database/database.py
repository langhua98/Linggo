"""数据库连接。开发用 SQLite，正式用 PostgreSQL（DATABASE_URL=postgresql+psycopg2://...）。
API 进程和 Worker 进程各自建连接；SQLite 开 WAL + busy_timeout，两个进程同时写不会互相报「database is locked」。"""
from contextlib import contextmanager
from datetime import datetime, timezone

from sqlalchemy import create_engine, event
from sqlalchemy.orm import DeclarativeBase, sessionmaker

from ..config import get_settings


class Base(DeclarativeBase):
    pass


def utcnow():
    # 存不带时区的 UTC：SQLite 不保存时区，两种数据库表现一致
    return datetime.now(timezone.utc).replace(tzinfo=None)


_engine = None
_Session = None


def get_engine():
    global _engine, _Session
    if _engine is None:
        url = get_settings().database_url
        if url.startswith('postgres://'):
            url = 'postgresql+psycopg2://' + url[len('postgres://'):]
        elif url.startswith('postgresql://'):
            url = 'postgresql+psycopg2://' + url[len('postgresql://'):]
        kw = {'pool_pre_ping': True}
        if url.startswith('sqlite'):
            kw['connect_args'] = {'check_same_thread': False, 'timeout': 30}
        _engine = create_engine(url, **kw)
        if url.startswith('sqlite'):
            @event.listens_for(_engine, 'connect')
            def _pragmas(conn, _):
                cur = conn.cursor()
                cur.execute('PRAGMA journal_mode=WAL')
                cur.execute('PRAGMA foreign_keys=ON')
                cur.execute('PRAGMA busy_timeout=30000')
                cur.close()
        _Session = sessionmaker(bind=_engine, expire_on_commit=False)
    return _engine


def reset_engine():
    global _engine, _Session
    if _engine is not None:
        _engine.dispose()
    _engine = None
    _Session = None


def init_db():
    from .. import models  # noqa: F401 — 注册所有表
    Base.metadata.create_all(get_engine())


def new_session():
    get_engine()
    return _Session()


def get_db():
    """FastAPI 依赖：每个请求一个会话。"""
    db = new_session()
    try:
        yield db
    finally:
        db.close()


@contextmanager
def session_scope():
    db = new_session()
    try:
        yield db
        db.commit()
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()
