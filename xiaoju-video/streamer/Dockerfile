FROM python:3.11-slim-bookworm

ENV PYTHONUNBUFFERED=1 \
    PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers \
    MC_DIR=/opt/MediaCrawler \
    MC_PY=/opt/mc-venv/bin/python
# ffmpeg：整理视频；git：取 MediaCrawler；xvfb：给有界面的 Chromium 一块虚拟屏幕；
# nodejs：MediaCrawler 算抖音接口签名（libs/douyin.js）；libgl1：它的滑块验证用 OpenCV；中文字体：截图里的字
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg git ca-certificates xvfb xauth nodejs libgl1 libglib2.0-0 fonts-noto-cjk \
    && rm -rf /var/lib/apt/lists/*

# MediaCrawler（NanmiCoder/MediaCrawler，NON-COMMERCIAL LEARNING LICENSE 1.1）固定在验证过的版本，
# 装进自己的 venv：它钉的 fastapi 等版本和流式服务的不一样
ARG MC_REV=bf28178082bc69989954f65a13a17bc129b9aa6e
RUN git init -q $MC_DIR && git -C $MC_DIR remote add origin https://github.com/NanmiCoder/MediaCrawler.git \
    && git -C $MC_DIR fetch -q --depth 1 origin $MC_REV && git -C $MC_DIR checkout -q FETCH_HEAD
COPY mc_patch.py /tmp/mc_patch.py
RUN python /tmp/mc_patch.py $MC_DIR \
    && python -m venv /opt/mc-venv \
    && /opt/mc-venv/bin/pip install --no-cache-dir -r $MC_DIR/requirements.txt \
    && /opt/mc-venv/bin/playwright install --with-deps chromium \
    && rm -rf /var/lib/apt/lists/*

# Hugging Face 用 uid 1000 跑容器：MediaCrawler 要在自己目录里写浏览器档案（登录状态）
RUN useradd -m -u 1000 user && chown -R user:user $MC_DIR
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
# 测试文件不进镜像；新加模块记得在这里列上（漏了会 ModuleNotFoundError 起不来）
COPY app.py douyin.py mc.py jobs.py dy_login.py ks_login.py outbox.py ./
USER user

EXPOSE 7860
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "7860"]
