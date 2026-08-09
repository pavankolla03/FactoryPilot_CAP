"""Identity context (Component_Contracts.md section 1).

`dev` mode trusts headers the Approuter would set and is for local work only.
Real XSUAA/IAS JWT validation is Day 13 of the delivery plan; selecting
`auth_mode=xsuaa` before that lands fails loudly rather than quietly accepting
unverified tokens.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from fastapi import Header, HTTPException, Request, status

from app.config import Settings, get_settings


@dataclass(slots=True)
class Identity:
    user_id: str
    roles: list[str] = field(default_factory=list)
    scopes: list[str] = field(default_factory=list)
    attributes: dict[str, str] = field(default_factory=dict)

    def has_scope(self, scope: str) -> bool:
        return scope in self.scopes or scope in self.roles


def _split(value: str | None) -> list[str]:
    return [v.strip() for v in (value or "").split(",") if v.strip()]


async def current_identity(
    request: Request,
    x_user_id: str | None = Header(default=None),
    x_user_roles: str | None = Header(default=None),
    x_user_warehouse: str | None = Header(default=None),
) -> Identity:
    settings: Settings = get_settings()

    if settings.auth_mode == "xsuaa":
        raise HTTPException(
            status_code=status.HTTP_501_NOT_IMPLEMENTED,
            detail=(
                "auth_mode=xsuaa requires JWT/JWKS validation, which is Day 13 of the "
                "delivery plan. Use auth_mode=dev until then."
            ),
        )

    user_id = x_user_id or settings.dev_default_user
    roles = _split(x_user_roles) or settings.dev_role_list
    attributes = {}
    if x_user_warehouse:
        attributes["warehouse"] = x_user_warehouse

    return Identity(user_id=user_id, roles=roles, scopes=roles, attributes=attributes)


def require_scope(identity: Identity, scope: str) -> None:
    if not identity.has_scope(scope):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=f"Missing required scope: {scope}",
        )
