import base64
import json

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import or_, select

from app.db import AsyncSession, get_db
from app.db.models import CoreConfig, CoreType, Node, NodeStatus
from app.models.admin import AdminDetails
from app.models.nordvpn import (
    NordCoreImpactResponse,
    NordCountry,
    NordCredentialsRequest,
    NordCredentialsResponse,
    NordGateway,
    NordGatewaysResponse,
    NordImpactNode,
    NordProbeRequest,
    NordProbeResponse,
    NordServersResponse,
)
from app.operation import OperatorType
from app.operation.node import NodeOperation
from app.utils import nordvpn, responses

from .authentication import require_permission

router = APIRouter(
    tags=["NordVPN"],
    prefix="/api/nordvpn",
    responses={401: responses._401, 403: responses._403},
)
node_operator = NodeOperation(operator_type=OperatorType.API)


def _nodes_for_core_statement(core_id: int):
    if core_id == 1:
        return select(Node).where(or_(Node.core_config_id == 1, Node.core_config_id.is_(None)))
    return select(Node).where(Node.core_config_id == core_id)


@router.post("/credentials", response_model=NordCredentialsResponse)
async def fetch_nord_credentials(
    request: NordCredentialsRequest,
    _: AdminDetails = Depends(require_permission("cores", "update")),
):
    return NordCredentialsResponse(private_key=await nordvpn.get_private_key(request.token))


@router.get("/countries", response_model=list[NordCountry])
async def fetch_nord_countries(_: AdminDetails = Depends(require_permission("cores", "update"))):
    return await nordvpn.get_countries()


@router.get("/servers", response_model=NordServersResponse)
async def fetch_nord_servers(
    country_id: int = Query(gt=0),
    _: AdminDetails = Depends(require_permission("cores", "update")),
):
    return NordServersResponse(servers=await nordvpn.get_servers(country_id))


@router.post("/probe", response_model=NordProbeResponse)
async def probe_nord_server(
    request: NordProbeRequest,
    admin: AdminDetails = Depends(require_permission("cores", "update")),
    db: AsyncSession = Depends(get_db),
):
    core = await db.get(CoreConfig, request.core_id)
    if core is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Core config not found.")
    if core.type != CoreType.xray:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="NordVPN requires an Xray core.")

    nodes = (await db.execute(_nodes_for_core_statement(request.core_id).order_by(Node.id))).scalars().all()
    if len(nodes) != 1:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Assign this core to exactly one gateway node before checking a Nord server.",
        )
    node = nodes[0]
    if node.status != NodeStatus.connected:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="The gateway node must be connected.")

    outbound = {
        "tag": f"nord-{request.server.hostname}",
        "protocol": "wireguard",
        "settings": {
            "secretKey": request.private_key,
            "address": ["10.5.0.2/32"],
            "peers": [
                {
                    "publicKey": request.server.public_key,
                    "endpoint": f"{request.server.station}:51820",
                }
            ],
            "noKernelTun": True,
        },
    }
    encoded = base64.urlsafe_b64encode(json.dumps(outbound, separators=(",", ":")).encode()).decode().rstrip("=")
    probe_name = f"pg-http-probe:v1:{encoded}"
    result = await node_operator.get_outbounds_latency(node.id, name=probe_name, timeout=25)
    if not result.latencies or result.latencies[0].source != "xray-http-probe":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="This node does not support pre-add outbound checks yet. Update the PasarGuard node agent.",
        )
    latency = result.latencies[0]
    return NordProbeResponse(
        node_id=node.id,
        node_name=node.name,
        alive=latency.alive,
        delay=latency.delay,
        link=latency.link,
        source=latency.source,
    )


@router.get("/core/{core_id}/impact", response_model=NordCoreImpactResponse)
async def get_nord_core_impact(
    core_id: int,
    _: AdminDetails = Depends(require_permission("cores", "update")),
    db: AsyncSession = Depends(get_db),
):
    core = await db.get(CoreConfig, core_id)
    if core is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Core config not found.")
    if core.type != CoreType.xray:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="NordVPN requires an Xray core.")

    nodes = (await db.execute(_nodes_for_core_statement(core_id).order_by(Node.id))).scalars().all()
    impact_nodes = [
        NordImpactNode(id=node.id, name=node.name, address=node.address, status=node.status) for node in nodes
    ]
    return NordCoreImpactResponse(
        core_id=core_id,
        nodes=impact_nodes,
        projected_direct_connections=len(impact_nodes),
        single_session_safe=len(impact_nodes) <= 1,
    )


def _find_nord_gateway(core: CoreConfig, nodes: list[Node]) -> NordGateway | None:
    if core.type != CoreType.xray or len(nodes) != 1 or not isinstance(core.config, dict):
        return None

    inbounds = core.config.get("inbounds") or []
    routing = core.config.get("routing") or {}
    rules = routing.get("rules") or [] if isinstance(routing, dict) else []
    for inbound in inbounds:
        if not isinstance(inbound, dict) or not str(inbound.get("tag") or "").startswith("nord-gateway-in"):
            continue
        settings = inbound.get("settings") or {}
        if inbound.get("protocol") != "shadowsocks" or not isinstance(settings, dict):
            continue
        inbound_tag = str(inbound["tag"])
        outbound_tag = None
        for rule in rules:
            if not isinstance(rule, dict) or inbound_tag not in (rule.get("inboundTag") or []):
                continue
            candidate = rule.get("outboundTag")
            if isinstance(candidate, str) and candidate.startswith("nord-"):
                outbound_tag = candidate
                break
        if not outbound_tag:
            continue
        try:
            port = int(inbound["port"])
            method = str(settings["method"])
            password = str(settings["password"])
        except KeyError, TypeError, ValueError:
            continue
        if not method or not password or not 1 <= port <= 65535:
            continue
        node = nodes[0]
        return NordGateway(
            core_id=core.id,
            core_name=core.name,
            node_id=node.id,
            node_name=node.name,
            address=node.address,
            port=port,
            method=method,
            password=password,
            inbound_tag=inbound_tag,
            nord_outbound_tag=outbound_tag,
        )
    return None


@router.get("/gateways", response_model=NordGatewaysResponse)
async def get_nord_gateways(
    _: AdminDetails = Depends(require_permission("cores", "update")),
    db: AsyncSession = Depends(get_db),
):
    cores = (await db.execute(select(CoreConfig).order_by(CoreConfig.id))).scalars().all()
    nodes = (await db.execute(select(Node).order_by(Node.id))).scalars().all()
    nodes_by_core: dict[int, list[Node]] = {}
    for node in nodes:
        nodes_by_core.setdefault(node.core_config_id or 1, []).append(node)

    gateways = []
    for core in cores:
        gateway = _find_nord_gateway(core, nodes_by_core.get(core.id, []))
        if gateway:
            gateways.append(gateway)
    return NordGatewaysResponse(gateways=gateways)
