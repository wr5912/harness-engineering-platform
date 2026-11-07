"""使用官方 Graph 验证分支、固定子流程、批次与取消，不替换调度器。"""
import asyncio
import hashlib
import json
import os
import unittest
import uuid
from unittest.mock import patch

from hep_lfx import HepBatch, HepChild, HepInput, current_run, run_graph


def node(cls, identity, code=None, output=False, **values):
    code = code or f"from hep_lfx import {cls.__name__} as BaseComponent\nclass {cls.__name__}(BaseComponent):\n pass\n"
    native = cls(_code=code).to_frontend_node()["data"]["node"]
    for name, value in values.items():
        native["template"][name]["value"] = value
    native["is_output"] = output
    return {"id": identity, "position": {"x": 0, "y": 0}, "data": {"id": identity, "type": cls.__name__, "node": native}}


def custom(identity, body, *, outputs=None, is_list=False, output=False):
    source = ('from hep_lfx import HepComponent, payload, current_run, callback\n'
              'from lfx.io import DataInput, Output\nfrom lfx.schema import Data\n'
              'import asyncio\nclass TestComponent(HepComponent):\n'
              f' inputs=[DataInput(name="value",is_list={is_list},required=True)]\n'
              f' outputs={outputs or "[Output(name=\"result\",method=\"build\")]"}\n' + body)
    namespace = {}
    exec(source, namespace)
    return node(namespace["TestComponent"], identity, source, output=output)


def edge(source, target, port="result"):
    return {"source": source, "target": target, "data": {
        "sourceHandle": {"id": source, "name": port, "dataType": "Data", "output_types": ["Data"]},
        "targetHandle": {"id": target, "fieldName": "value", "inputTypes": ["Data"], "type": "DataInput"}}}


def flow(nodes, edges):
    return {"data": {"nodes": nodes, "edges": edges}}


class Client:
    def __init__(self):
        self.events = []
        self.active = 0
        self.peak = 0

    async def post(self, _url, json, **_kwargs):
        self.events.append(json)
        if json["action"] == "work":
            self.active += 1
            self.peak = max(self.peak, self.active)
            try:
                await asyncio.sleep(json.get("delay", 0.01))
            finally:
                self.active -= 1
        value = json["input"] if json["action"] == "component" else None
        class Reply:
            def raise_for_status(self):
                pass

            def json(self):
                return {"value": value}
        return Reply()


class RuntimeTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.client = Client()
        self.run = {"client": self.client, "callback": "http://local", "token": "test", "bundle": {"children": {}, "modules": {}}, "shared": {"snapshot": "frozen"}}

    async def execute(self, native, value):
        token = current_run.set(self.run)
        try:
            return await run_graph(native, value, "root")
        finally:
            current_run.reset(token)

    async def test_all_branches_only_build_selected_path_and_join(self):
        methods = ''.join(f' async def route_{key}(self)->Data:\n'
                          f'  selected=payload(self.value)["selected"]\n'
                          '  for name in ("a","b","c"):\n'
                          '   if name!=selected:self.stop(name)\n'
                          '  self.graph.exclude_branches_conditionally(self._id,[name for name in ("a","b","c") if name!=selected])\n'
                          '  return self.value\n' for key in ('a', 'b', 'c'))
        router = custom('route', methods, outputs='[' + ','.join(f'Output(name="{key}",method="route_{key}",group_outputs=True)' for key in ('a', 'b', 'c')) + ']')
        branches = [custom(key, f' def build(self)->Data:\n  return Data(data={{"selected":"{key}"}})\n') for key in ('a', 'b', 'c')]
        merge = custom('merge', ' def build(self)->Data:\n  assert len(self.value)==1\n  return self.value[0]\n', is_list=True, output=True)
        native = flow([node(HepInput, 'input'), router, *branches, merge], [edge('input', 'route'), *[item for key in ('a', 'b', 'c') for item in (edge('route', key, key), edge(key, 'merge'))]])
        for selected in ('a', 'b', 'c'):
            self.client.events.clear()
            self.assertEqual(await self.execute(native, {"selected": selected}), {"selected": selected})
            built = {event["node_id"].split('/')[-1] for event in self.client.events if event.get("status") == 'completed'}
            self.assertEqual(built.intersection({'a', 'b', 'c'}), {selected})

    async def test_early_exit_and_deep_paths_have_independent_outputs(self):
        def router(identity, field):
            methods = ''.join(f' def route_{key}(self)->Data:\n'
                              f'  excluded=[key for key in ("early","deep") if key!=payload(self.value)["{field}"]]\n'
                              '  for key in excluded:self.stop(key)\n'
                              '  self.graph.exclude_branches_conditionally(self._id,excluded)\n'
                              '  return self.value\n' for key in ('early', 'deep'))
            return custom(identity, methods, outputs='[Output(name="early",method="route_early",group_outputs=True),Output(name="deep",method="route_deep",group_outputs=True)]')
        finish = ' def build(self)->Data:\n  return self.value\n'
        native = flow([node(HepInput, 'input'), router('outer', 'outer'), router('inner', 'inner'),
                       *[custom(name, finish, output=True) for name in ('early_end', 'inner_end', 'deep_end')]],
                      [edge('input', 'outer'), edge('outer', 'early_end', 'early'), edge('outer', 'inner', 'deep'),
                       edge('inner', 'inner_end', 'early'), edge('inner', 'deep_end', 'deep')])
        for outer, inner, expected in [('early', 'deep', 'early_end'), ('deep', 'early', 'inner_end'), ('deep', 'deep', 'deep_end')]:
            self.client.events.clear()
            value = {'outer': outer, 'inner': inner}
            self.assertEqual(await self.execute(native, value), value)
            built = {event['node_id'].split('/')[-1] for event in self.client.events if event.get('status') == 'completed'}
            self.assertEqual(built.intersection({'early_end', 'inner_end', 'deep_end'}), {expected})
            if outer == 'early':
                self.assertNotIn('inner', built)

    def batch(self, delay=0.01):
        body = flow([node(HepInput, 'input'), custom('check', f' async def build(self)->Data:\n  await callback("work",delay={delay})\n  return Data(data={{"index":payload(self.value)["item"],"snapshot":current_run.get()["shared"]["snapshot"]}})\n', output=True)], [edge('input', 'check')])
        return flow([node(HepInput, 'input'), node(HepBatch, 'batch', output=True, concurrency=3, body=body)], [edge('input', 'batch')])

    async def test_fixed_child_uses_shared_snapshot_and_bounded_stable_batch(self):
        native = self.batch()
        self.run['bundle']['children']['check:fixed'] = {'flow': native, 'children': {}, 'modules': {}}
        parent = flow([node(HepInput, 'input'), node(HepChild, 'child', output=True, composition_id='check', version_id='fixed')], [edge('input', 'child')])
        result = await self.execute(parent, {'items': list(range(9))})
        self.assertEqual(result['items'], [{'index': i, 'snapshot': 'frozen'} for i in range(9)])
        self.assertEqual(self.client.peak, 3)
        self.assertTrue(any(event.get('node_id', '').startswith('root/child/batch[') for event in self.client.events))

    async def test_cancel_stops_all_active_batch_workers(self):
        task = asyncio.create_task(self.execute(self.batch(delay=60), {'items': list(range(20))}))
        for _ in range(200):
            if self.client.active == 3:
                break
            await asyncio.sleep(0.02)
        self.assertEqual(self.client.active, 3)
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertEqual(self.client.active, 0)
        self.assertEqual(sum(event['action'] == 'work' for event in self.client.events), 3)

    async def test_distinct_child_nodes_do_not_collapse_identical_inputs(self):
        self.run['bundle']['children']['check:fixed'] = {'flow': self.batch(), 'children': {}, 'modules': {}}
        join = custom('join', ' def build(self)->Data:\n  assert len(self.value)==2\n  return self.value[0]\n', is_list=True, output=True)
        native = flow([node(HepInput, 'input'), *[node(HepChild, name, composition_id='check', version_id='fixed') for name in ('first', 'second')], join],
                      [edge('input', 'first'), edge('input', 'second'), edge('first', 'join'), edge('second', 'join')])
        result = await self.execute(native, {'items': [1, 2, 3]})
        self.assertEqual(len(result['items']), 3)
        self.assertEqual(sum(event['action'] == 'work' for event in self.client.events), 6)

    async def test_typescript_callback_binds_the_current_frozen_child_and_node(self):
        self.run['bundle']['typescript'] = 'frozen typescript'
        body = (' async def build(self)->Data:\n'
                '  from hep_lfx import component\n'
                '  return Data(data=await component("echo",payload(self.value),self._id))\n')
        native = flow([node(HepInput, 'input'), custom('typed', body, output=True)], [edge('input', 'typed')])
        self.assertEqual(await self.execute(native, {'target': 'test'}), {'target': 'test'})
        event = next(value for value in self.client.events if value['action'] == 'component')
        self.assertEqual(event['module_digest'], hashlib.sha256(b'frozen typescript').hexdigest())
        self.assertEqual(event['node_id'], 'root/typed')

    async def test_official_http_stream_ignores_external_proxy_for_local_callbacks(self):
        import httpx
        from server import app
        source = ('from lfx.custom import Component\nfrom lfx.io import Output\nfrom lfx.schema import Data\n'
                  'class Result(Component):\n inputs=[]\n outputs=[Output(name="result",method="build")]\n'
                  ' def build(self)->Data:\n  return Data(data={"ok":True})\n')
        namespace = {}
        exec(source, namespace)
        native = flow([node(namespace['Result'], 'result', source, output=True)], [])
        with patch.dict(os.environ, {'LANGFLOW_API_KEY': 'test', 'ALL_PROXY': 'socks5://127.0.0.1:1'}):
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test', headers={'x-api-key': 'test'}) as client:
                identity = str(uuid.uuid4())
                self.assertEqual((await client.post('/hep/runs/' + identity, json={})).status_code, 200)
                self.assertEqual((await client.post('/flows/upload/', json={'name': 'test', 'id': identity, 'data': native['data']})).status_code, 201)
                response = await client.post('/api/v2/workflows', headers={'x-hep-run': identity}, json={
                    'flow_id': identity, 'mode': 'stream', 'stream_protocol': 'langflow', 'expose_graph_state': True})
                self.assertEqual(response.status_code, 200)
                events = [json.loads(line[6:]) for line in response.text.splitlines() if line.startswith('data: ')]
                result = next(event['data']['build_data'] for event in events if event['event'] == 'end_vertex')
                self.assertEqual(result['data']['artifacts']['result']['raw'], {'ok': True})
                self.assertTrue(any(event['event'] == 'end' for event in events))
                await client.delete('/flows/' + identity)
                await client.delete('/hep/runs/' + identity)


if __name__ == '__main__':
    unittest.main()
