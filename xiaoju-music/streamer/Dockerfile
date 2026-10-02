FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1
# 浏览器装在公共目录：Space 运行时不是 root，读不到 /root/.cache
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
# ffmpeg：算音柱数据时把各种格式的音频解成采样；整理抖音视频、截缩略图
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY requirements.txt .
# Chromium：不登录打开抖音网页版拿视频（douyin/web.py）
RUN pip install --no-cache-dir -r requirements.txt \
 && playwright install --with-deps chromium \
 && rm -rf /var/lib/apt/lists/* \
 && chmod -R a+rX /ms-playwright
COPY app.py .
COPY harvest ./harvest
COPY douyin ./douyin

EXPOSE 7860
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "7860"]
