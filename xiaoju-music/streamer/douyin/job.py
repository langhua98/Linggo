"""抖音：一次只跑一件事，结果记在 state 里，跑完用机器人通知频道主。

- collect：采集一个账号作品的公开链接（不登录）。没登录时抖音只给看一部分：账号最新的几条作品被藏起来
  （作品列表接口返回里写着「登录看更多最新作品」），而且只给第一页（18 条），这些采不到的结果里如实标出来。
- mirror：采集之后把其中的作品转进频道（旧的先发）：视频发视频，图文发成相册（说明在第一张上）。下载地址作品
  列表里就有（不带水印的那个），不用再解析。
- one：把一条作品转进频道（频道主把分享链接发给机器人）：解析 → 下载 → 发帖。单条作品的详情接口从机房 IP
  打开常弹滑块验证，弹了就停下、告诉频道主（不去做验证码）。
查重：每次先把频道翻一遍，从帖子说明的原视频链接里认出转过的作品号，已有的不重发（不用 Telegram 的搜索，
实测搜不到链接里的作品号）。"""

import asyncio
import logging
import time

from .items import caption, hashtag
from .web import Blocked, DownloadError, Gone

log = logging.getLogger('streamer.douyin')

IMPORT_IDLE = 20 * 60  # 边抓边转：云电脑这么久没再送作品来、也没说抓完，就当它停了，收尾
MESSAGE_LIMIT = 3500  # 一条消息放多少字的链接（Telegram 上限 4096）
MAX_MESSAGES = 8
AHEAD = 3  # 同时在下载、处理、上传的作品条数（发帖还是一条条按顺序发）


class DouyinJob:
    def __init__(self, *, web, send_video, posted_ids, send_images=None, say=None, pause=3.0,
                 import_idle=IMPORT_IDLE, poll=5.0, retag=None, prepare_video=None, ahead=AHEAD):
        # prepare_video(字节, 作品, 档, 频道) → 已经传到 Telegram、只差发帖的视频；有它时 send_video(备好的, 说明, 频道) 只发帖。
        # 这样几条视频的下载、ffmpeg、上传能同时做，发帖仍按顺序（频道里的先后不乱）
        # retag(频道, 消息号, 作品)：频道里已经有、但说明里还没有账号标签的旧帖，补上标签（改说明，不重发）
        # posted_ids(频道) → {作品号: 消息号}：频道里已经转过的（每次跑先翻一遍频道，查重靠它）
        self.web, self.send_video, self.send_images, self.posted_ids = web, send_video, send_images, posted_ids
        self.say, self.pause = say, pause
        self.import_idle, self.poll = import_idle, poll
        self.retag, self.tags = retag, {}
        self.prepare_video, self.ahead = prepare_video, max(1, ahead)
        self._inbox, self._seen, self._final = [], set(), True
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

    def start_import(self, items, notify=None, target=None, final=True, tags=None):
        """MediaCrawler 导出的作品（频道主自己登录抓的，见 mcimport.py）：转进频道，已有的跳过。
        边抓边转：final=False 表示云电脑还在抓，后面的批次用 feed_import 接着送进来，转完手上的就等下一批；
        等到 final（抓完了）或者 IMPORT_IDLE 没动静，收尾、通知频道主"""
        self._inbox, self._final = list(items), final
        self._seen = {i['id'] for i in items}
        self._begin(lambda: self._import(notify, target), mode='import', target=target, name='',
                    total=len(self._seen), posted=[], skipped=[], failed=[], other=0, hidden_newest=False,
                    truncated=False, tags_used={})
        self.tags = dict(tags or {})

    def importing(self, target):
        """正在给 target 频道边抓边转（还能往里送）"""
        return self.running() and self.state.get('mode') == 'import' and self.state.get('target') == target

    def feed_import(self, items, final=False, tags=None):
        """往正在跑的导入里再送一批（送过的作品号不重复收），返回新收下几条"""
        self.tags.update(tags or {})
        new = [i for i in items if i['id'] not in self._seen]
        self._seen.update(i['id'] for i in new)
        self._inbox.extend(new)
        self.state['total'] = self.state.get('total', 0) + len(new)
        if final:
            self._final = True
        return len(new)

    async def _import(self, notify, target):
        st = self.state
        try:
            done = await self.posted_ids(target)
            names, waited = set(), 0.0
            async with self.web() as w:
                while True:
                    batch, self._inbox = self._inbox, []
                    if not batch:
                        if self._final or waited >= self.import_idle:
                            break
                        await asyncio.sleep(self.poll)
                        waited += self.poll
                        continue
                    waited = 0.0
                    st['other'] += sum(i['kind'] not in ('video', 'images') for i in batch)
                    names |= {i['author'] for i in batch if i['author']}
                    st['name'] = '、@'.join(sorted(names))
                    # 同一批里旧的先发（批与批之间按云电脑抓到的顺序：抖音的作品列表是新的在前）
                    await self._post_all(w, sorted((i for i in batch if i['kind'] in ('video', 'images')),
                                                   key=lambda i: i['time']), target, done)
            st['status'] = 'done'
            await self._tell(notify, mirror_report(st))
        except asyncio.CancelledError:
            st['status'] = 'stopped'
        except Exception as e:  # noqa: BLE001
            log.exception('douyin import failed')
            st['status'], st['error'] = 'error', f'{type(e).__name__}: {e}'[:200]
            await self._tell(notify, f'转作品的时候出错了（{type(e).__name__}），已转 {len(st["posted"])} 条')

    def start_collect(self, sec_uid, limit=300, notify=None):
        self._begin(lambda: self._collect(sec_uid, limit, notify), mode='collect', sec_uid=sec_uid, name='',
                    links=[], hidden_newest=False, truncated=False)

    def start_mirror(self, sec_uids, notify=None, target=None, quiet=False, tags=None):
        """sec_uids：频道主自己的一个或几个账号。quiet：定时自动同步用，没转新的、也没出错就不发消息"""
        sec_uids = [sec_uids] if isinstance(sec_uids, str) else list(sec_uids)
        self._begin(lambda: self._mirror(sec_uids, notify, target, quiet), mode='mirror', sec_uids=sec_uids, target=target, name='',
                    posted=[], skipped=[], failed=[], other=0, hidden_newest=False, truncated=False, tags_used={})
        self.tags = dict(tags or {})

    def _label(self, item):
        """给作品贴上账号标签：频道主起的名字优先（tags: sec_uid → 名字），没起就用抖音昵称"""
        tag = self.tags.get(item.get('sec_uid') or '') or hashtag(item.get('author'))
        item['tag'] = tag
        if tag and item.get('sec_uid'):
            self.state.setdefault('tags_used', {})[item['sec_uid']] = tag

    async def _post(self, w, item, target, done):
        """转一条作品到 target 频道：done（频道里已有的 {作品号: 消息号}）里有就跳过 → (帖子的消息号, 是不是新发的)。
        视频发视频，图文发成相册。发了就记进 done，同一次里不会再发"""
        return await self._send(item, await self._fetch(w, item, target, done), target, done)

    async def _fetch(self, w, item, target, done):
        """下载一条作品（视频顺便处理好、传上去）：频道里已有的不下载 → None"""
        self._label(item)
        if item['id'] in done:
            return None
        if item['kind'] == 'images':
            return await w.download_images(item)
        data, src = await w.download(item)
        if self.prepare_video:
            return await self.prepare_video(data, item, src, target)
        return data, src

    async def _send(self, item, got, target, done):
        if got is None and item['id'] not in done:
            raise DownloadError('同一条前面没转成')
        if got is None or item['id'] in done:
            if self.retag and item.get('tag'):
                try:
                    await self.retag(target, done[item['id']], item)
                except Exception:  # noqa: BLE001  补标签失败不影响转作品
                    log.exception('retag failed')
            return done[item['id']], False
        if item['kind'] == 'images':
            done[item['id']] = await self.send_images(got, item, caption(item), target)
        elif self.prepare_video:
            done[item['id']] = await self.send_video(got, caption(item), target)
        else:
            data, src = got
            done[item['id']] = await self.send_video(data, item, src, caption(item), target)
        return done[item['id']], True

    async def _post_all(self, w, items, target, done):
        """按顺序一条条发帖，但后面 ahead 条已经在同时下载、处理、上传了（发帖只是最后一步，很快）"""
        st, todo = self.state, list(items)
        first = {}
        for n, i in enumerate(todo):
            first.setdefault(i['id'], n)

        async def again(item):  # 同一次里重复出现的作品（置顶又在正常位置）不再下载，发的时候 done 里已经有它
            self._label(item)

        tasks = {}

        def fetch_upto(n):
            for k in range(n, min(n + self.ahead, len(todo))):
                if k not in tasks:
                    item = todo[k]
                    tasks[k] = asyncio.ensure_future(self._fetch(w, item, target, done) if first[item['id']] == k else again(item))

        try:
            for n, item in enumerate(todo):
                fetch_upto(n)
                row = {'id': item['id'], 'kind': item['kind'], 'desc': item['desc'][:60], 'time': item['time']}
                try:
                    got = await tasks.pop(n)
                except (DownloadError, Gone) as e:
                    row['reason'] = str(e)
                    st['failed'].append(row)
                    continue
                fetch_upto(n + 1)
                try:
                    row['msg'], fresh = await self._send(item, got, target, done)
                except (DownloadError, Gone) as e:
                    row['reason'] = str(e)
                    st['failed'].append(row)
                    continue
                (st['posted'] if fresh else st['skipped']).append(row)
                if fresh:
                    await asyncio.sleep(self.pause)  # 慢慢发，免得被 Telegram 限流（后面几条照样在准备）
        finally:
            for t in tasks.values():
                t.cancel()
            for t in tasks.values():
                try:
                    left = await t
                except BaseException:  # noqa: BLE001  没用上的那几条：出错、被取消都不管了
                    continue
                close = getattr(left, 'close', None)
                if close:
                    close()  # 备好了没发出去的视频：删掉临时文件

    async def _mirror(self, sec_uids, notify, target, quiet=False):
        """采集这几个账号能看到的作品，视频和图文按发布顺序（旧的先）转进频道，已有的跳过。
        某个账号这次没拿到（风控）不影响别的账号；全都没拿到才算出错"""
        st = self.state
        try:
            done = await self.posted_ids(target)
            async with self.web() as w:
                items, names, blocked = [], [], []
                for sec_uid in sec_uids:
                    try:
                        got, info = await w.posts(sec_uid)
                    except Blocked as e:
                        blocked.append(str(e))
                        continue
                    items += got
                    st['hidden_newest'] = st['hidden_newest'] or info['hidden_newest']
                    st['truncated'] = st['truncated'] or info['truncated']
                    name = next((i['author'] for i in got if i['author']), '')
                    if name:
                        names.append(name)
                if blocked and len(blocked) == len(sec_uids):
                    raise Blocked(blocked[0])
                st['blocked_accounts'] = len(blocked)
                st['name'] = '、@'.join(names)
                st['other'] = sum(i['kind'] not in ('video', 'images') for i in items)
                await self._post_all(w, sorted((i for i in items if i['kind'] in ('video', 'images') and i.get('public', True)),
                                               key=lambda i: i['time']), target, done)
            st['status'] = 'done'
            if not quiet or st['posted'] or st['failed']:
                await self._tell(notify, mirror_report(st))
        except Blocked as e:
            st['status'], st['blocked'], st['error'] = 'error', True, str(e)
            if not quiet:
                await self._tell(notify, f'这次没拿到作品列表（{e}）。过一会儿再试')
        except asyncio.CancelledError:
            st['status'] = 'stopped'
        except Exception as e:  # noqa: BLE001
            log.exception('douyin mirror failed')
            st['status'], st['error'] = 'error', f'{type(e).__name__}: {e}'[:200]
            await self._tell(notify, f'转作品的时候出错了（{type(e).__name__}），已转 {len(st["posted"])} 条')

    async def _collect(self, sec_uid, limit, notify):
        st = self.state
        try:
            async with self.web() as w:
                items, info = await w.posts(sec_uid, limit)
            st['name'] = next((i['author'] for i in items if i['author']), '')
            st['links'] = [{'id': i['id'], 'url': i['url'], 'kind': i['kind'], 'time': i['time'], 'desc': i['desc'][:60]}
                           for i in items if i.get('public', True)]
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
                await self._tell(notify, '这条频道里已经有了 👌')
                return
            async with self.web() as w:
                item = await w.detail(aweme_id)
                st['desc'] = item['desc'][:60]
                if item['kind'] not in ('video', 'images'):
                    st['status'], st['error'] = 'error', '这种作品转不了'
                    await self._tell(notify, '这种作品（不是视频也不是图文）转不了 🙏')
                    return
                st['msg'], st['fresh'] = await self._post(w, item, target, done)
            st['status'] = 'done'
            await self._tell(notify, f'✅ 已转到视频频道：{item["desc"][:60] or aweme_id}' if st['fresh'] else '这条频道里已经有了 👌')
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


KIND_NAMES = {'video': '视频', 'images': '图文'}


def mirror_report(st):
    posted = st['posted']
    counts = '、'.join(f'{name} {n}' for k, name in KIND_NAMES.items() if (n := sum(r.get('kind') == k for r in posted)))
    lines = [f'📤 抖音{" @" + st["name"] if st["name"] else ""}：转进视频频道 {len(posted)} 条' + (f'（{counts}）' if counts else '')]
    lines += [f'· {_day(r["time"])} [{KIND_NAMES.get(r.get("kind"), "?")}] {r["desc"][:30]}' for r in posted]
    if st['skipped']:
        lines.append(f'频道里已经有的 {len(st["skipped"])} 条跳过')
    if st['failed']:
        lines += ['没转成的：'] + [f'· {_day(r["time"])} {r["desc"][:20]}：{r["reason"]}' for r in st['failed']]
    if st.get('other'):
        lines.append(f'还有 {st["other"]} 条不是视频也不是图文，没转')
    if st.get('hidden_newest') or st.get('truncated'):
        lines.append('⚠️ 抖音不给没登录的人看' + '、'.join(x for x, on in (('最新的几条', st.get('hidden_newest')),
                                                                ('第一页以后的', st.get('truncated'))) if on)
                     + '作品，那些没转到；视频可以直接把文件发给我，点按钮转到频道。')
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
