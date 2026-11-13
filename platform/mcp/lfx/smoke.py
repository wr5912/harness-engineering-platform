"""在目标容器中验证锁定 LFX 的实际上传与执行，不访问外部业务服务。"""
import asyncio
import json
import uuid
from importlib.metadata import version

import httpx
from server import app


async def main():
    assert version('lfx') == '1.13.1'
    source = ('from lfx.custom import Component\nfrom lfx.io import Output\nfrom lfx.schema import Data\n'
              'class Result(Component):\n inputs=[]\n outputs=[Output(name="result",method="build")]\n'
              ' def build(self)->Data:\n  return Data(data={"ok":True})\n')
    namespace = {}
    exec(source, namespace)
    native = namespace['Result'](_code=source).to_frontend_node()['data']['node']
    native['is_output'] = True
    data = {'nodes': [{'id': 'result', 'position': {'x': 0, 'y': 0},
                       'data': {'id': 'result', 'type': 'Result', 'node': native}}], 'edges': []}
    identity = str(uuid.uuid4())
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test',
                                 headers={'x-api-key': 'packaging-smoke'}) as client:
        try:
            response = await client.post('/hep/runs/' + identity, json={})
            response.raise_for_status()
            response = await client.post('/flows/upload/', json={'name': 'packaging-smoke', 'id': identity, 'data': data})
            assert response.status_code == 201, response.text
            response = await client.post('/api/v2/workflows', headers={'x-hep-run': identity}, json={
                'flow_id': identity, 'mode': 'stream', 'stream_protocol': 'langflow', 'expose_graph_state': True})
            response.raise_for_status()
            events = [json.loads(line[6:]) for line in response.text.splitlines() if line.startswith('data: ')]
            built = next(event['data']['build_data'] for event in events if event['event'] == 'end_vertex')
            assert built['valid'] is True, built
            assert built['data']['artifacts']['result']['raw'] == {'ok': True}, built
            assert any(event['event'] == 'end' for event in events), events
            print(json.dumps({'lfx': version('lfx'), 'upload': 201, 'execute': 200, 'result': {'ok': True}}))
        finally:
            await client.delete('/flows/' + identity)
            await client.delete('/hep/runs/' + identity)


if __name__ == '__main__':
    asyncio.run(main())
