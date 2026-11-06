"""为官方 LFX serve 注入本地运行上下文；不实现流程调度。"""
import json
import os
import socket

import httpx
import uvicorn
from fastapi import HTTPException, Request
from lfx.cli.serve_app import FlowRegistry, create_multi_serve_app

from hep_lfx import current_run

app = create_multi_serve_app(registry=FlowRegistry(no_env_fallback=True))
runs = {}


def authenticate(request):
    if request.headers.get("x-api-key") != os.environ["LANGFLOW_API_KEY"]:
        raise HTTPException(status_code=401)


@app.post("/hep/runs/{run_id}")
async def register_run(run_id: str, request: Request):
    authenticate(request)
    body = await request.json()
    runs[run_id] = body
    return {"ok": True}


@app.delete("/hep/runs/{run_id}")
async def forget_run(run_id: str, request: Request):
    authenticate(request)
    runs.pop(run_id, None)
    return {"ok": True}


class RunContext:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        headers = dict(scope.get("headers", []))
        run_id = headers.get(b"x-hep-run", b"").decode()
        if not run_id:
            return await self.app(scope, receive, send)
        if headers.get(b"x-api-key", b"").decode() != os.environ["LANGFLOW_API_KEY"] or run_id not in runs:
            from starlette.responses import JSONResponse
            return await JSONResponse({"error": "运行上下文不存在"}, status_code=403)(scope, receive, send)
        # ASGI 生命周期覆盖整个 SSE 响应；断开后官方执行器负责取消 Graph。
        async with httpx.AsyncClient(timeout=65, trust_env=False) as client:
            token = current_run.set({**runs[run_id], "client": client})
            try:
                await self.app(scope, receive, send)
            finally:
                current_run.reset(token)


app.add_middleware(RunContext)


if __name__ == "__main__":
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    print(json.dumps({"port": sock.getsockname()[1]}), flush=True)
    uvicorn.Server(uvicorn.Config(app, log_level="error", access_log=False)).run(sockets=[sock])
