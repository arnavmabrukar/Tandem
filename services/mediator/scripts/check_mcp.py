"""Verify the local mediator's MCP endpoint through a real HTTP client."""

import asyncio

from mcp import ClientSession
from mcp.client.streamable_http import streamable_http_client


async def main() -> None:
    # Match the trailing slash on the FastAPI mount.
    url = "https://tandem-jr3e.onrender.com/mcp/"

    # Bound the check so an unreachable server cannot leave it waiting forever.
    async with asyncio.timeout(30):
        # These streams carry MCP messages over HTTP, not standard input/output.
        async with streamable_http_client(url) as (read, write):
            async with ClientSession(read, write) as session:
                # Complete the protocol handshake before discovering tools.
                await session.initialize()
                tools = await session.list_tools()
                names = [tool.name for tool in tools.tools]
                print("Available tools:", names)
                if "tandem_status" not in names:
                    raise RuntimeError("Server did not expose tandem_status")

                # Invoke the registered tool through the HTTP endpoint.
                result = await session.call_tool("tandem_status", {})
                if result.is_error:
                    raise RuntimeError(f"Tool failed: {result.content}")

                expected = {"service": "tandem-mcp", "status": "ok"}
                if result.structured_content != expected:
                    raise RuntimeError(f"Unexpected status: {result.structured_content}")
                # Printing is safe here: this is a test client, not a stdio server.
                print("Status result:", result.structured_content)


if __name__ == "__main__":
    asyncio.run(main())
