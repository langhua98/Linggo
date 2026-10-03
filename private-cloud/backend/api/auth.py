from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..database import get_db, utcnow
from ..models import User
from ..security import (clear_session_cookie, current_user, hash_password, login_limiter, set_session_cookie,
                        verify_password)
from ..services import file_service, log_service

router = APIRouter(prefix='/api/auth', tags=['auth'])


class LoginIn(BaseModel):
    username: str = Field(max_length=64)
    password: str = Field(max_length=256)


class PasswordIn(BaseModel):
    old_password: str = Field(max_length=256)
    new_password: str = Field(min_length=8, max_length=256)


def client_ip(request):
    fwd = request.headers.get('x-forwarded-for', '')
    return fwd.split(',')[0].strip() if fwd else (request.client.host if request.client else '')


def serialize_user(u):
    return {'id': u.id, 'username': u.username, 'is_admin': u.is_admin}


@router.post('/login')
def login(body: LoginIn, request: Request, response: Response, db: Session = Depends(get_db)):
    ip = client_ip(request)
    if login_limiter.blocked(ip):
        raise HTTPException(429, '尝试次数太多，请 15 分钟后再试')
    user = db.scalar(select(User).where(User.username == body.username.strip()))
    if user is None or user.disabled or not verify_password(body.password, user.password_hash):
        login_limiter.fail(ip)
        log_service.record('login_failed', f'用户名 {body.username.strip()[:64]}', level='warning', source='auth', ip=ip)
        raise HTTPException(401, '用户名或密码错误')
    login_limiter.reset(ip)
    user.last_login_at = utcnow()
    db.commit()
    set_session_cookie(response, user)
    log_service.record('login', user.username, source='auth', user_id=user.id, ip=ip)
    return serialize_user(user)


@router.post('/logout')
def logout(response: Response):
    clear_session_cookie(response)
    return {'ok': True}


@router.get('/me')
def me(user: User = Depends(current_user), db: Session = Depends(get_db)):
    return {**serialize_user(user), 'usage': file_service.usage(db, user)}


@router.post('/password')
def change_password(body: PasswordIn, request: Request, response: Response, user: User = Depends(current_user),
                    db: Session = Depends(get_db)):
    if not verify_password(body.old_password, user.password_hash):
        raise HTTPException(400, '原密码不对')
    user.password_hash = hash_password(body.new_password)
    user.token_version += 1          # 其它设备上的登录全部失效
    db.commit()
    set_session_cookie(response, user)
    log_service.record('password_changed', user.username, source='auth', user_id=user.id, ip=client_ip(request))
    return {'ok': True}
