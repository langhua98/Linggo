from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import User
from ..security import current_user
from ..services import file_service as fs

router = APIRouter(prefix='/api/folders', tags=['folders'])


class FolderIn(BaseModel):
    name: str = Field(max_length=300)
    parent_id: int | None = None


class RenameIn(BaseModel):
    name: str = Field(max_length=300)


class MoveIn(BaseModel):
    target_folder_id: int | None = None


@router.get('')
def tree(user: User = Depends(current_user), db: Session = Depends(get_db)):
    """全部文件夹（平铺，前端按 parent_id 拼成树）。"""
    return {'folders': fs.folder_tree(db, user)}


@router.post('')
def create(body: FolderIn, user: User = Depends(current_user), db: Session = Depends(get_db)):
    return fs.serialize_folder(fs.create_folder(db, user, body.name, body.parent_id))


@router.post('/{folder_id}/rename')
def rename(folder_id: int, body: RenameIn, user: User = Depends(current_user), db: Session = Depends(get_db)):
    return fs.serialize_folder(fs.rename_folder(db, user, folder_id, body.name))


@router.post('/{folder_id}/move')
def move(folder_id: int, body: MoveIn, user: User = Depends(current_user), db: Session = Depends(get_db)):
    return fs.serialize_folder(fs.move_folder(db, user, folder_id, body.target_folder_id))


@router.delete('/{folder_id}')
def delete(folder_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    """进回收站（连同里面所有文件和子文件夹）。"""
    fs.trash_folder(db, user, folder_id)
    return {'ok': True}


@router.post('/{folder_id}/restore')
def restore(folder_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    return fs.serialize_folder(fs.restore_folder(db, user, folder_id))
