"""密码哈希（标准库 scrypt）+ 登录令牌（JWT，放 HttpOnly Cookie，<video src> 这种请求也能带上）。"""
import base64
import hashlib
import hmac
import secrets
import time
from datetime import timedelta

import jwt
from fastapi import Depends, HTTPException, Request
from sqlalchemy.orm import Session

from .config import get_settings
from .database import get_db
from .models import User

COOKIE = 'pcd_session'
_N, _R, _P = 2 ** 14, 8, 1


def hash_password(password):
    salt = secrets.token_bytes(16)
    dk = hashlib.scrypt(password.encode(), salt=salt, n=_N, r=_R, p=_P, dklen=32)
    return 'scrypt$%d$%d$%d$%s$%s' % (_N, _R, _P, base64.b64encode(salt).decode(), base64.b64encode(dk).decode())


def verify_password(password, stored):
    try:
        algo, n, r, p, salt, dk = stored.split('$')
        if algo != 'scrypt':
            return False
        want = base64.b64decode(dk)
        got = hashlib.scrypt(password.encode(), salt=base64.b64decode(salt), n=int(n), r=int(r), p=int(p), dklen=len(want))
        return hmac.compare_digest(want, got)
    except (ValueError, TypeError):
        return False


def make_token(user):
    s = get_settings()
    now = int(time.time())
    payload = {'sub': str(user.id), 'ver': user.token_version, 'iat': now,
               'exp': now + int(timedelta(days=s.session_days).total_seconds())}
    return jwt.encode(payload, s.jwt_secret, algorithm='HS256')


def set_session_cookie(response, user):
    s = get_settings()
    response.set_cookie(COOKIE, make_token(user), max_age=s.session_days * 86400, httponly=True,
                        secure=s.cookie_secure, samesite='lax', path='/')


def clear_session_cookie(response):
    response.delete_cookie(COOKIE, path='/')


def _user_from_request(request, db):
    token = request.cookies.get(COOKIE)
    if not token:
        auth = request.headers.get('authorization', '')
        if auth.lower().startswith('bearer '):
            token = auth[7:]
    if not token:
        return None
    try:
        payload = jwt.decode(token, get_settings().jwt_secret, algorithms=['HS256'])
    except jwt.PyJWTError:
        return None
    user = db.get(User, int(payload.get('sub', 0)))
    if user is None or user.disabled or user.token_version != payload.get('ver'):
        return None
    return user


def current_user(request: Request, db: Session = Depends(get_db)):
    """所有文件 API 都依赖它：没登录直接 401，不靠前端藏按钮。"""
    user = _user_from_request(request, db)
    if user is None:
        raise HTTPException(401, '请先登录')
    return user


def admin_user(user: User = Depends(current_user)):
    if not user.is_admin:
        raise HTTPException(403, '需要管理员权限')
    return user


class LoginLimiter:
    """同一 IP 15 分钟内输错 10 次就先锁住，防暴力猜密码（单进程内存计数，私人云盘够用）。"""

    def __init__(self, limit=10, window=900):
        self.limit, self.window = limit, window
        self.fails = {}

    def _recent(self, key):
        now = time.time()
        items = [t for t in self.fails.get(key, []) if now - t < self.window]
        self.fails[key] = items
        return items

    def blocked(self, key):
        return len(self._recent(key)) >= self.limit

    def fail(self, key):
        self._recent(key).append(time.time())

    def reset(self, key):
        self.fails.pop(key, None)


login_limiter = LoginLimiter()
