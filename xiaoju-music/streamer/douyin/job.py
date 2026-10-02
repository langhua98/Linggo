"""抖音：一次只跑一件事，结果记在 state 里，跑完用机器人通知频道主。

- collect：采集一个账号作品的公开链接（不登录）。没登录时抖音只给看一部分：账号最新的几条作品被藏起来
  （作品列表接口返回里写着「登录看更多最新作品」），而且只给第一页（18 条），这些采不到的结果里如实标出来。
- mirror：采集之后把其中的视频转进频道（旧的先发）。下载地址作品列表里就有（不带水印的那个），不用再解析。
- one：把一条作品转进频道（频道主把分享链接发给机器人）：解析 → 下载 → 发帖。单条作品的详情接口从机房 IP
  打开常弹滑块验证，弹了就停下、告诉频道主（不去做验证码）。
查重：每次先把频道翻一遍，从帖子说明的原视频链接里认出转过的作品号，已有的不重发（不用 Telegram 的搜索，
实测搜不到链接里的作品号）。"""

import asyncio
import logging
import time

from .items import caption
from .web import Blocked, DownloadError, Gone

log = logging.getLogger('streamer.douyin')

MESSAGE_LIMIT = 3500  # 一条消息放多少字的链接（Telegram 上限 4096）
MAX_MESSAGES = 8


class DouyinJob:
    def __init__(self, *, web, send_video, posted_ids, say=None, pause=3.0):
        # posted_ids(频道) → {作品号: 消息号}：频道里已经转过的（每次跑先翻一遍频道，查重靠它）
        self.web, self.send_video, self.posted_ids, self.say, self.pause = web, send_video, posted_ids, say, pause
        self.task = None
        self.state = {'status': 'idle'}

    def running(self):
        return self.task is not None and not self.task.done()

    def _begin(self, run, **info):
        if self.running():
            raise RuntimeError('already running')
        self.state = {'status': 'running', 'blocked': False, 'error': '', **info}
        self.task = asyncio.create_task(run())

    def start(self, aweme_id, notify=None, target=None):
        aweme_id = str(aweme_id)
        self._begin(lambda: self._one(aweme_id, notify, target), mode='one', id=aweme_id, target=target, msg=None,
                    fresh=False, desc='')

    def start_collect(self, sec_uid, limit=300, notify=None):
        self._begin(lambda: self._collect(sec_uid, limit, notify), mode='collect', sec_uid=sec_uid, name='',
                    links=[], hidden_newest=False, truncated=False)

    def start_mirror(self, sec_uid, notify=None, target=None):
        self._begin(lambda: self._mirror(sec_uid, notify, target), mode='mirror', sec_uid=sec_uid, target=target, name='',
                    posted=[], skipped=[], failed=[], images=0, hidden_newest=False, truncated=False)

    async def _post(self, w, item, target, done):
        """转一条视频到 target 频道：done（频道里已有的 {作品号: 消息号}）里有就跳过 → (帖子的消息号, 是不是新发的)。
        发了就记进 done，同一次里不会再发"""
        if item['id'] in done:
            return done[item['id']], False
        data, src = await w.download(item)
        done[item['id']] = await self.send_video(data, item, src, caption(item), target)
        return done[item['id']], True

    async def _mirror(self, sec_uid, notify, target):
        """采集这个账号能看到的作品，视频按发布顺序（旧的先）转进频道，已有的跳过"""
        st = self.state
        try:
            done = await self.posted_ids(target)
            async with self.web() as w:
                items, info = await w.posts(sec_uid)
                st.update(info)
                st['name'] = next((i['author'] for i in items if i['author']), '')
                st['images'] = sum(i['kind'] == 'images' for i in items)
                for item in sorted((i for i in items if i['kind'] == 'video'), key=lambda i: i['time']):
                    row = {'id': item['id'], 'desc': item['desc'][:60], 'time': item['time']}
                    try:
                        row['msg'], fresh = await self._post(w, item, target, done)
                    except (DownloadError, Gone) as e:
                        row['reason'] = str(e)
                        st['failed'].append(row)
                        continue
                    (st['posted'] if fresh else st['skipped']).append(row)
                    if fresh:
                        await asyncio.sleep(self.pause)  # 慢慢发，免得被 Telegram 限流
            st['status'] = 'done'
            await self._tell(notify, mirror_report(st))
        except Blocked as e:
            st['status'], st['blocked'], st['error'] = 'error', True, str(e)
            await self._tell(notify, f'这次没拿到作品列表（{e}）。过一会儿再试')
        except asyncio.CancelledError:
            st['status'] = 'stopped'
        except Exception as e:  # noqa: BLE001
            log.exception('douyin mirror failed')
            st['status'], st['error'] = 'error', f'{type(e).__name__}: {e}'[:200]
            await self._tell(notify, f'转视频的时候出错了（{type(e).__name__}），已转 {len(st["posted"])} 条')

    async def _collect(self, sec_uid, limit, notify):
        st = self.state
        try:
            async with self.web() as w:
                items, info = await w.posts(sec_uid, limit)
            st['name'] = next((i['author'] for i in items if i['author']), '')
            st['links'] = [{'id': i['id'], 'url': i['url'], 'kind': i['kind'], 'time': i['time'], 'desc': i['desc'][:60]}
                           for i in items]
            st.update(info)
            st['status'] = 'done'
            for text in links_report(st):
                await self._tell(notify, text)
        except Blocked as e:
            st['status'], st['blocked'], st['error'] = 'error', True, str(e)
            await self._tell(notify, f'这次没采到（{e}）。过一会儿再发一次主页链接试试')
        except asyncio.CancelledError:
            st['status'] = 'stopped'
        except Exception as e:  # noqa: BLE001
            log.exception('douyin collect failed')
            st['status'], st['error'] = 'error', f'{type(e).__name__}: {e}'[:200]
            await self._tell(notify, f'采集的时候出错了（{type(e).__name__}）')

    async def _one(self, aweme_id, notify, target):
        st = self.state
        try:
            done = await self.posted_ids(target)
            if aweme_id in done:  # 频道里已经有了就不去碰抖音
                st['status'], st['msg'] = 'done', done[aweme_id]
                await self._tell(notify, '这条视频频道里已经有了 👌')
                return
            async with self.web() as w:
                item = await w.detail(aweme_id)
                st['desc'] = item['desc'][:60]
                if item['kind'] != 'video':
                    st['status'], st['error'] = 'error', '这是图文作品，现在只转视频'
                    await self._tell(notify, '这条是图文作品，现在只转视频 🙏')
                    return
                st['msg'], st['fresh'] = await self._post(w, item, target, done)
            st['status'] = 'done'
            await self._tell(notify, f'✅ 已转到视频频道：{item["desc"][:60] or aweme_id}' if st['fresh'] else '这条视频频道里已经有了 👌')
        except Blocked as e:
            st['status'], st['blocked'], st['error'] = 'error', True, str(e)
            await self._tell(notify, f'这次抖音没让我拿到这条视频（{e}）。\n过几分钟再发一次链接试试；急的话直接把视频文件发给我，我帮你转到视频频道。')
        except (Gone, DownloadError) as e:
            st['status'], st['error'] = 'error', str(e)
            await self._tell(notify, f'这条视频转不了：{e}\n可以直接把视频文件发给我，我帮你转到视频频道。')
        except asyncio.CancelledError:
            st['status'] = 'stopped'
        except Exception as e:  # noqa: BLE001
            log.exception('douyin job failed')
            st['status'], st['error'] = 'error', f'{type(e).__name__}: {e}'[:200]
            await self._tell(notify, f'转这条视频的时候出错了（{type(e).__name__}）。可以直接把视频文件发给我，我帮你转到视频频道。')

    async def _tell(self, chat, text):
        if chat and self.say:
            try:
                await self.say(chat, text)
            except Exception:  # noqa: BLE001
                log.exception('notify failed')


def _day(ts):
    return time.strftime('%Y-%m-%d', time.gmtime(ts + 8 * 3600)) if ts else '????-??-??'


def mirror_report(st):
    lines = [f'📤 抖音 @{st["name"] or "?"}：转进视频频道 {len(st["posted"])} 条视频']
    lines += [f'· {_day(r["time"])} {r["desc"][:30]}' for r in st['posted']]
    if st['skipped']:
        lines.append(f'频道里已经有的 {len(st["skipped"])} 条跳过')
    if st['failed']:
        lines += ['没转成的：'] + [f'· {_day(r["time"])} {r["desc"][:20]}：{r["reason"]}' for r in st['failed']]
    if st.get('images'):
        lines.append(f'图文作品 {st["images"]} 条没转（只转视频）')
    if st.get('hidden_newest') or st.get('truncated'):
        lines.append('⚠️ 抖音不给没登录的人看' + '、'.join(x for x, on in (('最新的几条', st.get('hidden_newest')),
                                                                ('第一页以后的', st.get('truncated'))) if on)
                     + '作品，那些没转到；可以把视频文件直接发给我，点按钮转到频道。')
    return '\n'.join(lines)


def links_report(st):
    """采集结果 → 几条消息：先是统计，再是链接（视频在前、图文在后，各自新的在前）"""
    links = st['links']
    videos = [x for x in links if x['kind'] == 'video']
    notes = [x for x in links if x['kind'] == 'images']
    others = [x for x in links if x['kind'] not in ('video', 'images')]
    head = [f'🔗 抖音 @{st["name"] or "?"} 的作品链接：共 {len(links)} 条（视频 {len(videos)}、图文 {len(notes)}'
            + (f'、其他 {len(others)}' if others else '') + '）']
    if st.get('hidden_newest'):
        head.append('⚠️ 抖音不给没登录的人看这个账号最新的几条作品，那几条不在下面。')
    if st.get('truncated'):
        head.append('⚠️ 抖音只给没登录的人看第一页，更早的作品采不到。')
    if not links:
        return ['\n'.join(head + ['这个账号没有公开作品。'])]
    blocks = []
    for title, group in (('视频', videos), ('图文', notes), ('其他', others)):
        if group:
            blocks.append(f'\n{title}：')
            for x in sorted(group, key=lambda x: x['time'], reverse=True):
                blocks.append(f'{_day(x["time"])} {x["desc"][:20]}\n{x["url"]}')
    out, cur = [], '\n'.join(head)
    for b in blocks:
        if len(cur) + len(b) + 1 > MESSAGE_LIMIT:
            out.append(cur)
            cur = b.lstrip('\n')
        else:
            cur += '\n' + b
    out.append(cur)
    if len(out) > MAX_MESSAGES:
        out = out[:MAX_MESSAGES]
        out[-1] += f'\n……太多了，只发了前面的。完整列表在流式服务的 /douyin/status 里（共 {len(links)} 条）'
    return out
