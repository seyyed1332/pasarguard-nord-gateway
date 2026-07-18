from pydantic import BaseModel, Field, field_validator

from app.db.models import NodeStatus


class NordCredentialsRequest(BaseModel):
    token: str = Field(min_length=16, max_length=512)

    @field_validator("token")
    @classmethod
    def strip_token(cls, value: str) -> str:
        return value.strip()


class NordCredentialsResponse(BaseModel):
    private_key: str


class NordCountry(BaseModel):
    id: int
    name: str
    code: str


class NordServer(BaseModel):
    id: int
    name: str
    hostname: str
    station: str
    load: int
    city_id: int | None = None
    city_name: str | None = None
    public_key: str


class NordServersResponse(BaseModel):
    servers: list[NordServer]


class NordProbeRequest(BaseModel):
    core_id: int = Field(gt=0)
    private_key: str = Field(min_length=40, max_length=128)
    server: NordServer

    @field_validator("private_key")
    @classmethod
    def strip_private_key(cls, value: str) -> str:
        return value.strip()


class NordProbeResponse(BaseModel):
    node_id: int
    node_name: str
    alive: bool
    delay: int
    link: str
    source: str


class NordBulkProbeRequest(BaseModel):
    core_id: int = Field(gt=0)
    private_key: str = Field(min_length=40, max_length=128)
    servers: list[NordServer] = Field(min_length=1, max_length=96)

    @field_validator("private_key")
    @classmethod
    def strip_bulk_private_key(cls, value: str) -> str:
        return value.strip()


class NordBulkProbeResult(BaseModel):
    server_id: int
    hostname: str
    load: int
    node_id: int
    node_name: str
    alive: bool
    delay: int
    link: str
    source: str


class NordBulkProbeResponse(BaseModel):
    scanned: int
    working: int
    results: list[NordBulkProbeResult]


class NordImpactNode(BaseModel):
    id: int
    name: str
    address: str
    status: NodeStatus


class NordCoreImpactResponse(BaseModel):
    core_id: int
    nodes: list[NordImpactNode]
    projected_direct_connections: int
    single_session_safe: bool


class NordGateway(BaseModel):
    core_id: int
    core_name: str
    node_id: int
    node_name: str
    address: str
    port: int
    method: str
    password: str
    inbound_tag: str
    nord_outbound_tag: str


class NordGatewaysResponse(BaseModel):
    gateways: list[NordGateway]
