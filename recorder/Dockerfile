# Build context is the repo root: `railway up` from there.
FROM python:3.12-slim
WORKDIR /app
COPY recorder/requirements.txt recorder/
RUN pip install --no-cache-dir -r recorder/requirements.txt
COPY tables.json .
COPY recorder/*.py recorder/
CMD ["python", "recorder/main.py"]
