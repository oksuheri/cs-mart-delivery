FROM python:3.11-slim

WORKDIR /app

# Copy application files
COPY . /app

# Ensure cloudflared binary (if copied) is ignored or removed from container
RUN rm -f /app/cloudflared /app/tunnel_url.txt

# Render will pass $PORT dynamically, defaulting to 8000
ENV PORT=8000
EXPOSE 8000

CMD ["python", "server.py"]
