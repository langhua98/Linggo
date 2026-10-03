"""云电脑脚本里不用浏览器的部分：python -m pytest -q xiaoju-video/cloud"""

import douyin_self as ds


def raw(aid, rates=None, images=None):
    return {'aweme_id': aid, 'desc': f'作品{aid[-1]}', 'create_time': int(aid[-1]),
            'video': {'play_addr': {'url_list': ['https://v.douyinvod.com/low']}, 'bit_rate': rates or []},
            'images': images}


def test_items_from_picks_best_rate_dedups_and_skips_broken():
    payloads = [
        {'aweme_list': [raw('7300000000000000001', rates=[
            {'bit_rate': 900, 'play_addr': {'url_list': ['https://v.douyinvod.com/900']}},
            {'bit_rate': 2400, 'play_addr': {'url_list': ['https://v.douyinvod.com/2400']}},
            {'bit_rate': 5000, 'play_addr': {'url_list': []}},
        ])]},
        {'aweme_list': [raw('7300000000000000001'), raw('7300000000000000002', images=[{'url_list': ['https://p/1.jpg']}]),
                        {'aweme_id': '7300000000000000003', 'video': {}}]},
        None,
    ]
    items = ds.items_from(payloads)
    assert [i['aweme'] for i in items] == ['7300000000000000001', '7300000000000000002']
    assert items[0]['video_url'] == 'https://v.douyinvod.com/2400'
    assert items[1]['type'] == 'images'


def test_push_sends_only_new_in_batches(monkeypatch):
    calls = []

    def fake(cfg, path, body):
        calls.append((path, body))
        if path == '/dy-known':
            return {'known': ['7300000000000000000']}
        if path == '/dy-import':
            return {'added': len(body['items'])}
        return {'ok': True}

    monkeypatch.setattr(ds, 'worker_call', fake)
    items = [{'aweme': f'73000000000000{i:05d}'} for i in range(250)]
    added = ds.push({}, items, report=lambda m: None)
    assert added == 249
    imports = [b for p, b in calls if p == '/dy-import']
    assert [len(b['items']) for b in imports] == [100, 100, 49]
    assert calls[-1][1]['stage'] == '完成'
