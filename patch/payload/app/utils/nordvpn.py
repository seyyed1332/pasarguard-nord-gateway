from __future__ import annotations

import json
from typing import Any

import aiohttp
from fastapi import HTTPException, status

from app.models.nordvpn import NordCountry, NordServer

NORD_API_BASE = "https://api.nordvpn.com"
NORDLYNX_TECHNOLOGY_ID = 35
MAX_RESPONSE_BYTES = 10 * 1024 * 1024
REQUEST_TIMEOUT_SECONDS = 15


def _decode_json(body: bytes) -> Any:
    try:
        return json.loads(body)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="NordVPN returned an invalid response.",
        ) from exc


async def _get_json(path: str, *, params: dict[str, str] | None = None, token: str | None = None) -> Any:
    timeout = aiohttp.ClientTimeout(total=REQUEST_TIMEOUT_SECONDS)
    auth = aiohttp.BasicAuth("token", token) if token else None
    headers = {"Accept": "application/json", "User-Agent": "PasarGuard-NordVPN/1.0"}

    try:
        async with aiohttp.ClientSession(timeout=timeout, headers=headers) as session:
            async with session.get(f"{NORD_API_BASE}{path}", params=params, auth=auth) as response:
                if response.status in (status.HTTP_401_UNAUTHORIZED, status.HTTP_403_FORBIDDEN):
                    raise HTTPException(
                        status_code=status.HTTP_400_BAD_REQUEST,
                        detail="NordVPN rejected the access token.",
                    )
                if response.status != status.HTTP_200_OK:
                    raise HTTPException(
                        status_code=status.HTTP_502_BAD_GATEWAY,
                        detail=f"NordVPN API returned HTTP {response.status}.",
                    )
                body = bytearray()
                async for chunk in response.content.iter_chunked(64 * 1024):
                    body.extend(chunk)
                    if len(body) > MAX_RESPONSE_BYTES:
                        raise HTTPException(
                            status_code=status.HTTP_502_BAD_GATEWAY,
                            detail="NordVPN response exceeded the safety limit.",
                        )
                return _decode_json(bytes(body))
    except HTTPException:
        raise
    except (TimeoutError, aiohttp.ClientError) as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Could not reach the NordVPN API.",
        ) from exc


async def get_private_key(token: str) -> str:
    data = await _get_json("/v1/users/services/credentials", token=token)
    private_key = data.get("nordlynx_private_key") if isinstance(data, dict) else None
    if not isinstance(private_key, str) or not private_key.strip():
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="NordVPN did not return a NordLynx private key.",
        )
    return private_key.strip()


async def get_countries() -> list[NordCountry]:
    data = await _get_json("/v1/countries")
    if not isinstance(data, list):
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="NordVPN returned invalid countries.")

    countries = []
    for item in data:
        if not isinstance(item, dict):
            continue
        try:
            countries.append(NordCountry(id=int(item["id"]), name=str(item["name"]), code=str(item["code"])))
        except KeyError, TypeError, ValueError:
            continue
    return sorted(countries, key=lambda country: country.name.casefold())


def parse_servers(data: Any) -> list[NordServer]:
    if not isinstance(data, dict):
        return []

    locations = data.get("locations")
    location_cities: dict[int, tuple[int, str]] = {}
    if isinstance(locations, list):
        for location in locations:
            if not isinstance(location, dict):
                continue
            city = (location.get("country") or {}).get("city") or {}
            try:
                location_cities[int(location["id"])] = (int(city["id"]), str(city["name"]))
            except KeyError, TypeError, ValueError:
                continue

    parsed = []
    for item in data.get("servers") or []:
        if not isinstance(item, dict):
            continue
        public_key = None
        for technology in item.get("technologies") or []:
            if not isinstance(technology, dict) or technology.get("id") != NORDLYNX_TECHNOLOGY_ID:
                continue
            for metadata in technology.get("metadata") or []:
                if isinstance(metadata, dict) and metadata.get("name") == "public_key":
                    public_key = metadata.get("value")
                    break

        station = item.get("station")
        if not isinstance(public_key, str) or not public_key or not isinstance(station, str) or not station:
            continue

        city_id = None
        city_name = None
        location_ids = item.get("location_ids") or []
        if location_ids:
            try:
                city_id, city_name = location_cities.get(int(location_ids[0]), (None, None))
            except TypeError, ValueError:
                pass

        try:
            parsed.append(
                NordServer(
                    id=int(item["id"]),
                    name=str(item.get("name") or item["hostname"]),
                    hostname=str(item["hostname"]),
                    station=station,
                    load=int(item.get("load") or 0),
                    city_id=city_id,
                    city_name=city_name,
                    public_key=public_key,
                )
            )
        except KeyError, TypeError, ValueError:
            continue
    return sorted(parsed, key=lambda server: (server.load, server.hostname))


async def get_servers(country_id: int) -> list[NordServer]:
    data = await _get_json(
        "/v2/servers",
        params={
            "limit": "0",
            "filters[servers_technologies][id]": str(NORDLYNX_TECHNOLOGY_ID),
            "filters[country_id]": str(country_id),
        },
    )
    servers = parse_servers(data)
    if not servers:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="NordVPN returned no usable NordLynx servers for this country.",
        )
    return servers
