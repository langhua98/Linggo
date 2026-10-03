"""所有配置都从环境变量读。密钥（Bot Token、JWT_SECRET、数据库密码）只能放环境变量，不能写进代码或前端。"""
import os
import secrets
from dataclasses import dataclass, field
from pathlib import Path

MiB = 1024 * 1024


def _int(name, default):
    v = os.environ.get(name, '').strip()
    return int(v) if v else default


def _bool(name, default):
    v = os.environ.get(name, '').strip().lower()
    if not v:
        return default
    return v in ('1', 'true', 'yes', 'on')


def _routes(raw):
    """TELEGRAM_CHAT_ROUTES="video=-1001,image=-1002,document=-1003,archive=-1004" → {分类: 频道 ID}。"""
    out = {}
    for part in (raw or '').split(','):
        if '=' in part:
            k, v = part.split('=', 1)
            if k.strip() and v.strip():
                out[k.strip()] = int(v.strip())
    return out


@dataclass
class Settings:
    data_dir: Path
    database_url: str
    jwt_secret: str
    storage_backend: str              # telegram | local（local 只用于开发和测试：假装成 Telegram，文件放本地目录）
    telegram_api_id: int
    telegram_api_hash: str
    telegram_bot_token: str
    telegram_chat_id: int
    telegram_chat_routes: dict = field(default_factory=dict)
    chunk_size: int = 8 * MiB          # 浏览器分片大小
    max_file_size: int = 2000 * MiB    # 机器人走 MTProto 单文件上限 2 GB
    upload_concurrency: int = 2        # Worker 同时往 Telegram 传几个文件
    max_retries: int = 3               # 失败几次后标记 failed（含第一次）
    staging_ttl_hours: int = 72        # 失败/放弃的上传，临时文件留多久
    session_days: int = 30
    cookie_secure: bool = False
    admin_username: str = ''
    admin_password: str = ''
    frontend_dir: Path | None = None

    @property
    def staging_dir(self):
        return self.data_dir / 'staging'

    @property
    def backup_dir(self):
        return self.data_dir / 'backups'

    def chat_for(self, category):
        return self.telegram_chat_routes.get(category, self.telegram_chat_id)

    def all_chats(self):
        ids = {self.telegram_chat_id, *self.telegram_chat_routes.values()}
        return sorted(i for i in ids if i)


def _jwt_secret(data_dir):
    s = os.environ.get('JWT_SECRET', '').strip()
    if s:
        return s
    # 没配就生成一个存在数据目录里（开发方便）；正式部署请显式配置
    p = data_dir / '.jwt_secret'
    if p.exists():
        return p.read_text().strip()
    s = secrets.token_urlsafe(48)
    p.write_text(s)
    try:
        p.chmod(0o600)
    except OSError:
        pass
    return s


def load_settings():
    data_dir = Path(os.environ.get('DATA_DIR', 'data')).resolve()
    data_dir.mkdir(parents=True, exist_ok=True)
    for sub in ('staging', 'backups'):
        (data_dir / sub).mkdir(exist_ok=True)
    frontend = os.environ.get('FRONTEND_DIR', '').strip()
    if not frontend:
        guess = Path(__file__).resolve().parent.parent / 'frontend' / 'out'
        frontend = str(guess) if guess.is_dir() else ''
    return Settings(
        data_dir=data_dir,
        database_url=os.environ.get('DATABASE_URL', '').strip() or f'sqlite:///{data_dir / "cloud.db"}',
        jwt_secret=_jwt_secret(data_dir),
        storage_backend=os.environ.get('STORAGE_BACKEND', 'telegram').strip().lower(),
        telegram_api_id=_int('TELEGRAM_API_ID', 0),
        telegram_api_hash=os.environ.get('TELEGRAM_API_HASH', '').strip(),
        telegram_bot_token=os.environ.get('TELEGRAM_BOT_TOKEN', '').strip(),
        telegram_chat_id=_int('TELEGRAM_CHAT_ID', 0),
        telegram_chat_routes=_routes(os.environ.get('TELEGRAM_CHAT_ROUTES', '')),
        chunk_size=_int('CHUNK_SIZE_MB', 8) * MiB,
        max_file_size=_int('MAX_FILE_SIZE_MB', 2000) * MiB,
        upload_concurrency=max(1, _int('UPLOAD_CONCURRENCY', 2)),
        max_retries=max(1, _int('MAX_RETRIES', 3)),
        staging_ttl_hours=_int('STAGING_TTL_HOURS', 72),
        session_days=_int('SESSION_DAYS', 30),
        cookie_secure=_bool('COOKIE_SECURE', False),
        admin_username=os.environ.get('ADMIN_USERNAME', '').strip(),
        admin_password=os.environ.get('ADMIN_PASSWORD', ''),
        frontend_dir=Path(frontend) if frontend else None,
    )


_settings = None


def get_settings():
    global _settings
    if _settings is None:
        _settings = load_settings()
    return _settings


def reset_settings():
    """测试用：改完环境变量后重读。"""
    global _settings
    _settings = None
