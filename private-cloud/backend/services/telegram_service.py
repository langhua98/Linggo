"""Telegram 存储层。网站数据库只记「文件在 Telegram 哪个频道、哪条消息」，文件本体全在私有频道里。

用机器人账号走 MTProto（Telethon）而不是 HTTP Bot API：Bot API 上传限 50 MB、下载限 20 MB，
MTProto 机器人上传、下载单文件都能到 2 GB，还能按任意偏移读，在线播放视频拖进度条要靠这个。

每条消息的说明文字里带一份 JSON 元数据（文件名、大小、SHA-256、所在目录），
数据库丢了也能把频道扫一遍重建索引——这就是「Telegram 存储与网站数据库解耦」。

STORAGE_BACKEND=local 时换成 LocalStorage：接口一样，文件放本地目录，开发和测试不用真的连 Telegram。
"""
import asyncio
import json
import logging
import os
import time
from dataclasses import dataclass

log = logging.getLogger('cloud.telegram')

CAPTION_TAG = '#pcd'
BACKUP_TAG = '#pcd-backup'
CAPTION_LIMIT = 1024          # Telegram 说明文字上限
CHUNK = 512 * 1024            # 每次向 Telegram 取 512 KB（必须是 4 KB 的倍数且能整除 1 MB）
MESSAGE_TTL = 30 * 60
MAX_REFRESHES = 3


@dataclass
class StoredRef:
    chat_id: int
    message_id: int
    file_id: str | None
    size: int


@dataclass
class ScannedMessage:
    message_id: int
    meta: dict | None       # 解析出来的元数据；不是本系统传的文件为 None
    size: int
    filename: str | None
    mime: str | None
    file_id: str | None


def make_caption(meta):
    """meta: name/size/sha256/mime/path。文件名太长就截短，保证总长度不超过 Telegram 上限。"""
    meta = dict(meta, v=1)
    for _ in range(10):
        text = CAPTION_TAG + ' ' + json.dumps(meta, ensure_ascii=False, separators=(',', ':'))
        if len(text) <= CAPTION_LIMIT:
            return text
        for key in ('path', 'name'):
            if len(meta.get(key) or '') > 40:
                meta[key] = meta[key][:max(40, len(meta[key]) // 2)]
                break
    return CAPTION_TAG + ' ' + json.dumps({'v': 1, 'sha256': meta.get('sha256'), 'size': meta.get('size')})


def parse_caption(text):
    text = (text or '').strip()
    if not text.startswith(CAPTION_TAG + ' '):
        return None
    try:
        meta = json.loads(text[len(CAPTION_TAG) + 1:])
    except ValueError:
        return None
    return meta if isinstance(meta, dict) else None


def category_for(mime):
    """多频道分流用的大类：video / image / audio / document / archive / other。"""
    mime = (mime or '').lower()
    if mime.startswith('video/'):
        return 'video'
    if mime.startswith('image/'):
        return 'image'
    if mime.startswith('audio/'):
        return 'audio'
    if any(k in mime for k in ('zip', 'rar', '7z', 'tar', 'gzip', 'x-bzip', 'x-xz', 'compressed')):
        return 'archive'
    if mime.startswith('text/') or any(k in mime for k in ('pdf', 'word', 'excel', 'powerpoint', 'officedocument',
                                                           'opendocument', 'rtf', 'json', 'xml', 'epub')):
        return 'document'
    return 'other'


class StorageError(RuntimeError):
    pass


# ── 真 Telegram ─────────────────────────────────────────────────


class TelegramStorage:
    def __init__(self, settings, role='api'):
        self.s = settings
        self.role = role
        self.client = None
        self._peers = {}
        self._messages = {}   # (chat, id) -> (取到的时间, 消息)

    async def start(self):
        from telethon import TelegramClient
        s = self.s
        if not (s.telegram_api_id and s.telegram_api_hash and s.telegram_bot_token and s.telegram_chat_id):
            raise StorageError('缺少 TELEGRAM_API_ID / TELEGRAM_API_HASH / TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID')
        # 每个进程一份会话文件：API 和 Worker 各登录一次，以后重启直接复用，不会反复触发机器人登录限流
        session = str(s.data_dir / f'tg_{self.role}')
        self.client = TelegramClient(session, s.telegram_api_id, s.telegram_api_hash, receive_updates=False)
        await self.client.start(bot_token=s.telegram_bot_token)
        for chat in s.all_chats():
            await self._peer(chat)
        log.info('telegram storage ready (%s), chats=%s', self.role, s.all_chats())

    async def stop(self):
        if self.client:
            await self.client.disconnect()

    async def _peer(self, chat_id):
        if chat_id in self._peers:
            return self._peers[chat_id]
        from telethon import utils
        from telethon.tl.functions.channels import GetChannelsRequest
        from telethon.tl.types import InputChannel
        try:
            peer = await self.client.get_input_entity(chat_id)
        except (ValueError, TypeError):
            # 机器人没法「查历史对话」拿私有频道的 access_hash；用 access_hash=0 向服务器要一次频道信息即可
            real_id, _ = utils.resolve_id(chat_id)
            res = await self.client(GetChannelsRequest([InputChannel(real_id, 0)]))
            if not res.chats:
                raise StorageError(f'找不到频道 {chat_id}：机器人要先被加进频道并设为管理员')
            peer = utils.get_input_peer(res.chats[0])
        self._peers[chat_id] = peer
        return peer

    async def upload(self, path, *, chat_id, filename, mime, caption, progress=None):
        from telethon import utils
        from telethon.tl.types import DocumentAttributeFilename
        peer = await self._peer(chat_id)
        # 一律当文档发：图片、视频都保持原文件，不被 Telegram 压缩
        msg = await self.client.send_file(
            peer, str(path), caption=caption, parse_mode=None, force_document=True,
            attributes=[DocumentAttributeFilename(filename)], mime_type=mime or None,
            progress_callback=progress)
        try:
            file_id = utils.pack_bot_file_id(msg.media)
        except Exception:  # noqa: BLE001
            file_id = None
        size = msg.file.size if msg.file else os.path.getsize(path)
        return StoredRef(chat_id=chat_id, message_id=msg.id, file_id=file_id, size=size)

    async def _message(self, chat_id, message_id, fresh=False):
        key = (chat_id, message_id)
        hit = self._messages.get(key)
        if hit and not fresh and time.monotonic() - hit[0] < MESSAGE_TTL:
            return hit[1]
        msg = await self.client.get_messages(await self._peer(chat_id), ids=message_id)
        if msg is None or not msg.document:
            self._messages.pop(key, None)
            return None
        if len(self._messages) > 2000:
            self._messages.clear()
        self._messages[key] = (time.monotonic(), msg)
        return msg

    async def iter_range(self, chat_id, message_id, start, end):
        """边取边吐 [start, end]。文件引用（file reference）中途过期就重取消息，从断开处接着传。"""
        from telethon.errors import FileReferenceExpiredError
        pos = start
        refreshes = 0
        while pos <= end:
            msg = await self._message(chat_id, message_id, fresh=refreshes > 0)
            if msg is None:
                raise StorageError(f'Telegram 消息 {message_id} 不存在')
            doc = msg.document
            aligned = pos - pos % CHUNK
            skip = pos - aligned
            stream = self.client.iter_download(doc, offset=aligned, request_size=CHUNK, file_size=doc.size)
            try:
                async for chunk in stream:
                    if skip:
                        if len(chunk) <= skip:
                            skip -= len(chunk)
                            continue
                        chunk, skip = chunk[skip:], 0
                    chunk = chunk[:end - pos + 1]
                    yield chunk
                    pos += len(chunk)
                    if pos > end:
                        return
                return
            except FileReferenceExpiredError:
                refreshes += 1
                if refreshes > MAX_REFRESHES:
                    raise
            finally:
                close = getattr(stream, 'aclose', None) or getattr(stream, 'close', None)
                if close:
                    try:
                        await close()
                    except Exception:  # noqa: BLE001 — 没取过数据就关，Telethon 会报 AttributeError
                        pass

    async def delete(self, chat_id, message_ids):
        if message_ids:
            await self.client.delete_messages(await self._peer(chat_id), list(message_ids))
            for m in message_ids:
                self._messages.pop((chat_id, m), None)

    async def scan(self, chat_id, start_id, count):
        """按消息号顺序取一批（机器人不能翻聊天记录，但能按消息号取）。"""
        from telethon import utils
        ids = list(range(start_id, start_id + count))
        msgs = await self.client.get_messages(await self._peer(chat_id), ids=ids)
        out = []
        for m in msgs:
            if m is None or not m.document:
                continue
            try:
                fid = utils.pack_bot_file_id(m.media)
            except Exception:  # noqa: BLE001
                fid = None
            out.append(ScannedMessage(m.id, parse_caption(m.message), m.file.size, m.file.name, m.file.mime_type, fid))
        return out

    async def latest_id(self, chat_id):
        """发一条再删掉，拿到频道当前最大消息号（机器人没有别的办法知道）。"""
        peer = await self._peer(chat_id)
        m = await self.client.send_message(peer, '·')
        await self.client.delete_messages(peer, [m.id])
        return m.id


# ── 本地假 Telegram（开发 / 测试）────────────────────────────────


class LocalStorage:
    def __init__(self, settings, role='api'):
        self.s = settings
        self.root = settings.data_dir / 'local_store'

    async def start(self):
        self.root.mkdir(parents=True, exist_ok=True)

    async def stop(self):
        pass

    def _dir(self, chat_id):
        d = self.root / str(chat_id or 0)
        d.mkdir(parents=True, exist_ok=True)
        return d

    def _next_id(self, chat_id):
        d = self._dir(chat_id)
        counter = d / '_counter'
        n = int(counter.read_text()) + 1 if counter.exists() else 1
        counter.write_text(str(n))
        return n

    async def upload(self, path, *, chat_id, filename, mime, caption, progress=None):
        size = os.path.getsize(path)
        mid = self._next_id(chat_id)
        d = self._dir(chat_id)
        tmp = d / f'{mid}.tmp'
        with open(path, 'rb') as src, open(tmp, 'wb') as dst:
            done = 0
            while True:
                b = await asyncio.to_thread(src.read, 4 * 1024 * 1024)
                if not b:
                    break
                dst.write(b)
                done += len(b)
                if progress:
                    r = progress(done, size)
                    if asyncio.iscoroutine(r):
                        await r
        tmp.rename(d / f'{mid}.bin')
        (d / f'{mid}.json').write_text(json.dumps({'caption': caption, 'filename': filename, 'mime': mime, 'size': size}))
        return StoredRef(chat_id=chat_id, message_id=mid, file_id=f'local:{chat_id}:{mid}', size=size)

    async def iter_range(self, chat_id, message_id, start, end):
        p = self._dir(chat_id) / f'{message_id}.bin'
        if not p.exists():
            raise StorageError(f'Telegram 消息 {message_id} 不存在')
        with open(p, 'rb') as f:
            f.seek(start)
            left = end - start + 1
            while left > 0:
                b = f.read(min(CHUNK, left))
                if not b:
                    return
                left -= len(b)
                yield b
                await asyncio.sleep(0)

    async def delete(self, chat_id, message_ids):
        d = self._dir(chat_id)
        for m in message_ids:
            for ext in ('bin', 'json'):
                (d / f'{m}.{ext}').unlink(missing_ok=True)

    async def scan(self, chat_id, start_id, count):
        d = self._dir(chat_id)
        out = []
        for mid in range(start_id, start_id + count):
            meta_p = d / f'{mid}.json'
            if meta_p.exists():
                m = json.loads(meta_p.read_text())
                out.append(ScannedMessage(mid, parse_caption(m['caption']), m['size'], m['filename'], m['mime'],
                                          f'local:{chat_id}:{mid}'))
        return out

    async def latest_id(self, chat_id):
        counter = self._dir(chat_id) / '_counter'
        return int(counter.read_text()) if counter.exists() else 0


def create_storage(settings, role='api'):
    if settings.storage_backend == 'local':
        return LocalStorage(settings, role)
    if settings.storage_backend == 'telegram':
        return TelegramStorage(settings, role)
    raise StorageError(f'未知的 STORAGE_BACKEND={settings.storage_backend}')

