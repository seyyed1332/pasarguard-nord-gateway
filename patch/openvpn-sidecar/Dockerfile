FROM alpine:3.22

RUN apk add --no-cache ca-certificates curl dante-server openvpn python3

WORKDIR /app
COPY controller.py /app/controller.py
COPY sockd.conf /app/sockd.conf

EXPOSE 1080 8080
VOLUME ["/state"]

HEALTHCHECK --interval=15s --timeout=3s --retries=3 CMD wget -q -O- http://127.0.0.1:8080/health >/dev/null || exit 1
ENTRYPOINT ["python3", "/app/controller.py"]
