#!/usr/bin/env bash
# 小橘 · 抖音搜索 → 链接清单：用云电脑上登录的抖音（MediaCrawler 的 search 模式）搜关键词，
# 结果送给小橘，按点赞排好、私聊发给频道主，点链接在抖音里看。只收集链接，不下载、不转发别人的视频。
#   bash xiaoju-music/cloud/search.sh 舞蹈 街舞   —— 马上搜这几个词
#   bash xiaoju-music/cloud/search.sh            —— 搜机器人里「搜抖音 …」排队的词
HERE="$(cd "$(dirname "$0")" && pwd)"
KW="$(IFS=,; echo "$*")"
XJ_SEARCH_MODE=1 XJ_SEARCH="$KW" exec bash "$HERE/crawl.sh"
