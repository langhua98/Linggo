FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1
# ffmpeg：把抖音视频整理成网页能边下边播的 mp4（不重新编码），截封面、读时长尺寸
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app.py douyin.py ./

EXPOSE 7860
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "7860"]
