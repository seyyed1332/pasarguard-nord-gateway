ARG BASE_IMAGE

FROM oven/bun:1 AS dashboard-builder
WORKDIR /build/dashboard
COPY dashboard/package.json dashboard/bun.lock ./
RUN bun install --frozen-lockfile
COPY dashboard/ ./
ENV VITE_BASE_API=/
RUN bun run build

FROM ${BASE_IMAGE}
ARG PASARGUARD_VERSION
LABEL org.pasarguard.feature.nordvpn="one-session-gateway-v2-http-probe"
LABEL org.pasarguard.feature.nordvpn.base-version="${PASARGUARD_VERSION}"

COPY app/models/nordvpn.py /code/app/models/nordvpn.py
COPY app/routers/nordvpn.py /code/app/routers/nordvpn.py
COPY app/routers/__init__.py /code/app/routers/__init__.py
COPY app/utils/nordvpn.py /code/app/utils/nordvpn.py
RUN rm -rf /code/dashboard/build
COPY --from=dashboard-builder /build/dashboard/build /code/dashboard/build
