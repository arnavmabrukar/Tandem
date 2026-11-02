# Import the server class from the official MCP SDK.
from mcp.server import MCPServer
from typing import Any
from mcp.server.auth.middleware.auth_context import get_access_token


# This name identifies our server to MCP clients.
mcp = MCPServer("Tandem")


# Register this Python function as a tool an agent can call.
@mcp.tool()
def tandem_status() -> dict[str, str]:
    """Check whether the Tandem MCP server is responding."""

    # This checks only the MCP connection.
    # It does not verify authentication or database connectivity.
    return {
        "service": "tandem-mcp",
        "status": "ok",
    }


@mcp.tool()
def tandem_whoami() -> dict[str, Any]:
    """Return your authenticated agent identity and active project grants."""
    access = get_access_token()
    if access is None or not access.claims or "tandem_identity" not in access.claims:
        # Local stdio does not inherit hosted bearer authentication.
        raise ValueError("Connect through the hosted MCP endpoint with an agent token")
    # Explicitly return public identity fields, never the AccessToken object.
    return access.claims["tandem_identity"]

# Start the server only when this module is executed directly.
# Importing it from another Python file will not start it.
if __name__ == "__main__":
    # stdio lets the IDE's MCP client communicate with this process
    # through standard input and output.
    mcp.run(transport="stdio")
