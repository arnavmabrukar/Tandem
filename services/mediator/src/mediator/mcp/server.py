# Import the server class from the official MCP SDK.
from mcp.server import MCPServer


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

# Start the server only when this module is executed directly.
# Importing it from another Python file will not start it.
if __name__ == "__main__":
    # stdio lets the IDE's MCP client communicate with this process
    # through standard input and output.
    mcp.run(transport="stdio")