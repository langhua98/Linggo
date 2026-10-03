from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from ..config import get_settings
from ..database import get_db
from ..models import User
from ..security import current_user
from ..services import upload_service as us

router = APIRouter(prefix='/api', tags=['upload'])


class CreateIn(BaseModel):
    filename: str = Field(max_length=1000)
    file_size: int
    mime_type: str = Field('', max_length=255)
    sha256: str = Field(max_length=64)
    folder_id: int | None = None
    # 查重命中时：true = 不重新上传，直接在目标文件夹放一份（秒传）
    link_if_duplicate: bool = False


@router.get('/upload/config')
def config(user: User = Depends(current_user)):
    s = get_settings()
    return {'chunk_size': s.chunk_size, 'max_file_size': s.max_file_size}


@router.post('/upload/create')
def create(body: CreateIn, user: User = Depends(current_user), db: Session = Depends(get_db)):
    """第一步：浏览器算好 SHA-256 后调用。重复的文件直接返回已有的那份，不再上传。"""
    return us.create_task(db, user, filename=body.filename, size=body.file_size, mime=body.mime_type,
                          sha256=body.sha256, folder_id=body.folder_id, force_link=body.link_if_duplicate)


# 规划里写的 POST /api/files/upload：和 /api/upload/create 是同一个接口
router.add_api_route('/files/upload', create, methods=['POST'], include_in_schema=False)


@router.put('/upload/{task_id}/chunks/{idx}')
async def put_chunk(task_id: int, idx: int, request: Request, user: User = Depends(current_user),
                    db: Session = Depends(get_db)):
    """第二步：按分片传内容（请求体就是这一片的原始字节）。同一片重传没关系。"""
    limit = get_settings().chunk_size
    data = bytearray()
    async for part in request.stream():
        data.extend(part)
        if len(data) > limit:
            raise HTTPException(413, '分片太大')
    return us.write_chunk(db, user, task_id, idx, bytes(data))


@router.post('/upload/{task_id}/complete')
def complete(task_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    """第三步：分片传齐，交给 Worker 往 Telegram 传。"""
    return us.complete(db, user, task_id)


@router.get('/upload/{task_id}/status')
def status(task_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    return us.serialize_task(db, us.get_task(db, user, task_id), with_chunks=True)


@router.post('/upload/{task_id}/cancel')
def cancel(task_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    return us.cancel(db, user, task_id)


@router.post('/upload/{task_id}/retry')
def retry(task_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    return us.retry(db, user, task_id)


@router.get('/upload/tasks')
def tasks(user: User = Depends(current_user), db: Session = Depends(get_db)):
    return {'tasks': us.list_tasks(db, user)}


@router.post('/upload/tasks/clear')
def clear(user: User = Depends(current_user), db: Session = Depends(get_db)):
    return {'removed': us.clear_finished(db, user)}
