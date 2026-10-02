"""抖音视频转到频道：频道主把分享链接发给机器人 → 解析（不登录）→ 下载 → 发进频道。一次只转一条。

为什么不做「自动发现新视频」：抖音网页版不给没登录的人看账号最新的作品（作品列表里最新的几条被藏起来，
接口返回里写着「登录看更多最新作品」），而这正是要第一时间转的那几条。单条作品按作品号是能拿到的，
所以靠频道主发链接。

查重：发之前在频道里搜一下作品号（帖子说明里有原视频链接）。结果记在 state 里，转好或失败都用机器人通知。"""

import asyncio
import logging

from .items import caption
from .web import Blocked, DownloadError, Gone

log = logging.getLogger('streamer.douyin')


class DouyinJob:
    def __init__(self, *, web, send_video, find_posted, say=None):
        self.web, self.send_video, self.find_posted, self.say = web, send_video, find_posted, say
        self.task = None
        self.state = {'status': 'idle'}

    def running(self):
        return self.task is not None and not self.task.done()

    def start(self, aweme_id, notify=None):
        if self.running():
            raise RuntimeError('already running')
        aweme_id = str(aweme_id)
        self.state = {'status': 'running', 'id': aweme_id, 'msg': None, 'fresh': False, 'blocked': False, 'error': '', 'desc': ''}
        self.task = asyncio.create_task(self._run(aweme_id, notify))

    async def _run(self, aweme_id, notify):
        st = self.state
        try:
            old = await self.find_posted(aweme_id)
            if old:
                st['status'], st['msg'] = 'done', old
                await self._tell(notify, '这条视频频道里已经有了 👌')
                return
            async with self.web() as w:
                item = await w.detail(aweme_id)
                st['desc'] = item['desc'][:60]
                if item['kind'] != 'video':
                    st['status'], st['error'] = 'error', '这是图文作品，现在只转视频'
                    await self._tell(notify, '这条是图文作品，现在只转视频 🙏')
                    return
                data, src = await w.download(item)
            st['msg'] = await self.send_video(data, item, src, caption(item))
            st['status'], st['fresh'] = 'done', True
            await self._tell(notify, f'✅ 已转到频道：{item["desc"][:60] or aweme_id}')
        except Blocked as e:
            st['status'], st['blocked'], st['error'] = 'error', True, str(e)
            await self._tell(notify, f'这次抖音没让我拿到这条视频（{e}）。\n过几分钟再发一次链接试试；急的话直接把视频文件发给我，我帮你转到频道。')
        except (Gone, DownloadError) as e:
            st['status'], st['error'] = 'error', str(e)
            await self._tell(notify, f'这条视频转不了：{e}\n可以直接把视频文件发给我，我帮你转到频道。')
        except asyncio.CancelledError:
            st['status'] = 'stopped'
        except Exception as e:  # noqa: BLE001
            log.exception('douyin job failed')
            st['status'], st['error'] = 'error', f'{type(e).__name__}: {e}'[:200]
            await self._tell(notify, f'转这条视频的时候出错了（{type(e).__name__}）。可以直接把视频文件发给我，我帮你转到频道。')

    async def _tell(self, chat, text):
        if chat and self.say:
            try:
                await self.say(chat, text)
            except Exception:  # noqa: BLE001
                log.exception('notify failed')
